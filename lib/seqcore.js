/**
 * dsh-seqguard — sequence-integrity core (pure; only node:zlib).
 *
 * A v4 session artifact is a sequence of independent zstd frames: frame 0
 * holds exactly one JSON header line, later frames hold batches of
 * newline-delimited JSON events. Every event carries a `seq` that must be
 * strictly contiguous (0..N-1) — dsh's strict validator rejects the whole
 * log otherwise ("invalid committed event ... has seq gap").
 *
 * Observed corruption class (github.com/deepseek-ai/deepseek-harness
 * discussion #8984): on hosts without a write lease (Termux/bionic —
 * flock unsupported, posix-unlocked fallback) a seed-construction handle and
 * a stale resume handle can both append. The stale handle re-emits a seq
 * that already exists, and every later row is uniformly shifted by -1
 * relative to its row index. That single-shift shape is exactly repairable:
 * shift the duplicate row and everything after it by +1, leave frame
 * boundaries (and the frame-0 header) byte-identical.
 *
 * Everything here is deliberately conservative: unknown shapes refuse
 * instead of guessing. A refused file is never written.
 */
import { zstdDecompressSync, zstdCompressSync } from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Split a buffer into zstd frames. Frame boundaries come from magic scans
 * and are validated by actually decompressing; raw slices are kept so a
 * repair can reuse untouched frames byte-for-byte.
 * @returns {{frames: Array<{start:number,end:number,raw:Buffer,text?:string,error?:string}>, decompressErrors: number}}
 */
export function decodeFrames(buf) {
	const offsets = [];
	for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 4)) offsets.push(i);
	const frames = [];
	let decompressErrors = 0;
	for (let k = 0; k < offsets.length; k++) {
		const start = offsets[k];
		const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
		const raw = buf.subarray(start, end);
		try {
			frames.push({ start, end, raw, text: zstdDecompressSync(raw).toString("utf8") });
		} catch (error) {
			frames.push({ start, end, raw, error: error instanceof Error ? error.message : String(error) });
			decompressErrors++;
		}
	}
	return { frames, decompressErrors };
}

/**
 * Parse every frame's text into ordered rows.
 * Rows: {frame, line, json|null, isHeader, seq?}. Unparsable non-empty lines
 * are collected in `errors` (any error makes the buffer unrepairable).
 */
export function parseRows(frames) {
	const rows = [];
	const errors = [];
	frames.forEach((frame, frameIdx) => {
		if (frame.error !== undefined) return; // decompression failures handled by caller
		for (const line of frame.text.split("\n")) {
			if (line.trim() === "") continue;
			let json;
			try {
				json = JSON.parse(line);
			} catch {
				errors.push(`frame ${frameIdx}: unparsable line: ${line.slice(0, 120)}`);
				rows.push({ frame: frameIdx, line, json: null, isHeader: false });
				continue;
			}
			const isHeader = json?.type === "session";
			const seq = typeof json?.seq === "number" ? json.seq : undefined;
			rows.push({ frame: frameIdx, line, json, isHeader, seq });
		}
	});
	return { rows, errors };
}

/**
 * Classify parsed rows.
 *  - clean:            seqs strictly contiguous 0..N-1 (headers/no-seq rows ignored)
 *  - repairable:       first violation exists and EVERY row from there on keeps
 *                      one constant positive offset (expected - got == shift)
 *  - refuse:           any non-header row without numeric seq, or the offset
 *                      drifts (more than one independent gap)
 * @returns {{status:'clean'}|{status:'repairable', shift:number, from:number, detail:object}|{status:'refuse', reason:string}}
 */
export function inspect(rows) {
	let expected = 0;
	let firstViolation = null;
	let shift = null;
	let seenSeqRows = 0;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.isHeader) continue;
		if (row.json === null) return { status: "refuse", reason: "unparsable row present" };
		if (row.seq === undefined) {
			return { status: "refuse", reason: `non-header row without numeric seq at row ${i} (type=${row.json?.type})` };
		}
		if (firstViolation === null) {
			if (row.seq !== expected) {
				firstViolation = {
					rowIdx: i,
					eventIdx: seenSeqRows,
					expected,
					got: row.seq,
					type: row.json?.type,
					prevType: rows[i - 1]?.json?.type,
					row,
				};
				shift = expected - row.seq;
				if (shift <= 0 || shift > 1000) {
					return { status: "refuse", reason: `unusual first offset ${shift} at row ${i} (expected ${expected}, got ${row.seq})` };
				}
			}
		} else {
			const thisOffset = expected - row.seq;
			if (thisOffset !== shift) {
				return { status: "refuse", reason: `offset drifts at row ${i}: ${thisOffset} != ${shift} (second independent gap)` };
			}
		}
		expected++;
		seenSeqRows++;
	}
	if (firstViolation === null) return { status: "clean" };
	return { status: "repairable", shift, from: firstViolation.eventIdx, detail: firstViolation };
}

/**
 * Analyze a session buffer and (when repairable) build the repaired buffer.
 * Frame boundaries are preserved; the frame-0 header line and every row
 * before the violation are reused as raw bytes (only shifted rows are
 * re-serialized). Output is self-validated: decoded again and required to
 * classify as `clean` before it is returned.
 *
 * @returns
 *   {status:'clean', events}
 *   {status:'torn', detail}            — only the LAST frame fails to decompress
 *                                         (tail written concurrently / crash): leave alone
 *   {status:'corrupt', detail}         — a non-last frame fails, or rows unparsable
 *   {status:'repairable', shift, detail, events, out} — out is self-validated
 *   {status:'refuse', reason}
 */
export function analyze(buf) {
	if (!buf.subarray(0, 4).equals(MAGIC)) return { status: "corrupt", detail: "file does not start with a zstd frame magic" };
	const { frames, decompressErrors } = decodeFrames(buf);
	if (frames.length === 0) return { status: "corrupt", detail: "no zstd frames found" };
	if (decompressErrors > 0) {
		const badIdx = frames.map((f, i) => (f.error !== undefined ? i : -1)).filter((i) => i >= 0);
		if (badIdx.every((i) => i === frames.length - 1)) {
			return { status: "torn", detail: `only last frame ${badIdx[0]} fails: ${frames[badIdx[0]].error}` };
		}
		return { status: "corrupt", detail: `frames fail to decompress: ${badIdx.join(",")}` };
	}
	// Node's zstdDecompressSync is lenient with truncated input: it SUCCEEDS
	// and returns partial output instead of throwing. Every dsh frame ends on
	// a newline (batches of terminated rows, header frame = header + "\n"), so
	// a last frame whose text is empty or lacks the trailing newline means the
	// tail was cut mid-frame (concurrent write or crash) — never repair that.
	{
		const last = frames[frames.length - 1];
		if (last.text === "" || !last.text.endsWith("\n")) {
			return { status: "torn", detail: `last frame ${frames.length - 1} does not end on a newline (truncated tail; Node zstd returned partial output)` };
		}
	}
	const { rows, errors } = parseRows(frames);
	if (errors.length > 0) return { status: "corrupt", detail: errors[0] };
	const verdict = inspect(rows);
	const events = rows.filter((r) => r.seq !== undefined).length;
	if (verdict.status !== "repairable") {
		return verdict.status === "clean" ? { status: "clean", events } : verdict;
	}
	// Build the repaired buffer: rewrite only rows at eventIdx >= verdict.from.
	const out = [];
	let seqRowsSeen = 0;
	for (const frame of frames) {
		const outLines = [];
		let frameDirty = false;
		for (const line of frame.text.split("\n")) {
			if (line.trim() === "") continue;
			const json = JSON.parse(line);
			const hasSeq = typeof json?.seq === "number";
			if (hasSeq && seqRowsSeen >= verdict.from) {
				json.seq += verdict.shift;
				outLines.push(JSON.stringify(json));
				frameDirty = true;
			} else {
				outLines.push(line);
			}
			if (hasSeq) seqRowsSeen++;
		}
		if (frameDirty) {
			out.push(zstdCompressSync(Buffer.from(outLines.join("\n") + "\n")));
		} else {
			out.push(frame.raw); // byte-identical reuse
		}
	}
	const repaired = Buffer.concat(out);
	const recheck = analyze(repaired);
	if (recheck.status !== "clean") {
		return { status: "refuse", reason: `self-validation failed after shift: ${recheck.status} ${recheck.reason ?? recheck.detail ?? ""}` };
	}
	return {
		status: "repairable",
		shift: verdict.shift,
		from: verdict.from,
		detail: verdict.detail,
		events: recheck.events,
		out: repaired,
	};
}
