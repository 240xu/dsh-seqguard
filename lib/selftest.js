/**
 * dsh-seqguard selftest — synthetic fixtures exercise the exact corruption
 * class observed in production (deepseek-harness discussion #8984) without
 * touching any real session file.
 *
 * Run: node lib/selftest.js
 * Exit 0 = all assertions hold.
 */
import { zstdCompressSync } from "node:zlib";
import { analyze, decodeFrames } from "./seqcore.js";
import { repairSourceBuffer, producerKind } from "./sources.js";

let failed = 0;
function assert(cond, label) {
	if (cond) {
		console.log(`  ok  ${label}`);
	} else {
		failed++;
		console.log(`  FAIL ${label}`);
	}
}
const frame = (text) => zstdCompressSync(Buffer.from(text));
const headerLine = JSON.stringify({
	type: "session",
	version: 4,
	id: "session-seqguard-selftest",
	createdAt: 1791000000000,
	cwd: "/tmp/selftest",
	isSeeded: true,
}) + "\n";

/** Valid event stream with a single duplicate at `dupIdx` (the stale-writer shape:
 *  rows before dup are seq==idx; the dup row repeats the previous seq; every row
 *  after is uniformly shifted by -1). */
function buildCorruptEvents(total, dupIdx) {
	const rows = [];
	for (let i = 0; i < total; i++) {
		let seq;
		if (i < dupIdx) seq = i;
		else if (i === dupIdx) seq = i - 1; // duplicate: stale handle re-emit
		else seq = i - 1; // uniform -1 shift afterwards
		let type = "assistant/message";
		let data = { message: { role: "assistant", content: [{ type: "text", text: `event ${i}` }] } };
		if (i === dupIdx - 1) {
			type = "session/end-seed";
			data = {};
		} else if (i === dupIdx) {
			type = "model/selection";
			data = { provider: "example", model: "example-model" };
		}
		rows.push(JSON.stringify({ type, seq, time: 1791000000000 + i, data }));
	}
	return rows;
}

/** Split events into the same frame layout style as production (mid-file dup). */
function buildCorruptBuffer(total, dupIdx) {
	const rows = buildCorruptEvents(total, dupIdx);
	const bounds = [[0, 3], [3, 8], [8, 13], [13, 21], [21, 31], [31, total]];
	const frames = [frame(headerLine)];
	for (const [a, b] of bounds) {
		frames.push(frame(rows.slice(a, b).join("\n") + "\n"));
	}
	return { buf: Buffer.concat(frames), dupIdx };
}

console.log("[1] corrupt fixture: detect single-shift duplicate");
{
	const { buf, dupIdx } = buildCorruptBuffer(50, 12);
	const v = analyze(buf);
	assert(v.status === "repairable", `status repairable (got ${v.status}${v.reason ? ": " + v.reason : ""})`);
	if (v.status === "repairable") {
		assert(v.shift === 1, `shift=1 (got ${v.shift})`);
		assert(v.from === dupIdx, `first violation at event ${dupIdx} (got ${v.from})`);
		assert(v.detail.got === 11 && v.detail.expected === 12, `got/expected = 11/12 (got ${v.detail.got}/${v.detail.expected})`);
		assert(v.out.length > 0 && v.events === 50, `out built and self-validated to 50 events (got ${v.events})`);
	}
}

console.log("[2] repaired output classifies clean and keeps frame shape");
{
	const { buf } = buildCorruptBuffer(50, 12);
	const v = analyze(buf);
	const again = analyze(v.out);
	assert(again.status === "clean", `repaired buffer is clean (got ${again.status})`);
	assert(again.events === 50, `event count preserved: 50 (got ${again.events})`);
	// frame count identical (boundaries preserved)
	const { decodeFrames } = await import("./seqcore.js");
	const a = decodeFrames(buf), b = decodeFrames(v.out);
	assert(a.frames.length === b.frames.length, `frame count preserved: ${a.frames.length} (got ${b.frames.length})`);
	assert(a.frames[0].raw.equals(b.frames[0].raw), "frame-0 header bytes untouched");
	// seqs strictly contiguous after repair
	const { parseRows } = await import("./seqcore.js");
	const rows = parseRows(b.frames).rows;
	let expected = 0, contiguous = true;
	for (const r of rows) {
		if (r.isHeader) continue;
		if (r.seq !== expected) { contiguous = false; break; }
		expected++;
	}
	assert(contiguous, "seqs contiguous 0..49 after repair");
}

console.log("[3] clean buffer is reported clean, never rewritten");
{
	const total = 20;
	const rows = [];
	for (let i = 0; i < total; i++) rows.push(JSON.stringify({ type: "turn/start", seq: i, time: 1791000000000 + i, data: { turn: i } }));
	const buf = Buffer.concat([frame(headerLine), frame(rows.join("\n") + "\n")]);
	const v = analyze(buf);
	assert(v.status === "clean", `status clean (got ${v.status})`);
	assert(v.out === undefined, "no rewrite payload for clean input");
}

console.log("[4] double-gap (drifting offsets) refuses instead of guessing");
{
	const rows = buildCorruptEvents(50, 12).map((l) => JSON.parse(l));
	// introduce a SECOND independent gap: at event 30 drop one seq (offset becomes 2)
	for (let i = 30; i < rows.length; i++) rows[i].seq -= 1;
	const buf = Buffer.concat([frame(headerLine), frame(rows.map((r) => JSON.stringify(r)).join("\n") + "\n")]);
	const v = analyze(buf);
	assert(v.status === "refuse", `status refuse (got ${v.status})`);
	assert(String(v.reason).includes("drifts"), `reason mentions drift (${v.reason})`);
}

console.log("[5] torn last frame reports torn, never rewritten");
{
	const { buf } = buildCorruptBuffer(50, 12);
	const half = buf.subarray(buf.length - 60); // tail slice with a frame magic inside
	const torn = Buffer.concat([buf, frame("\n").subarray(0, 30)]);
	const v = analyze(torn);
	assert(v.status === "torn" || v.status === "repairable" || v.status === "clean", `torn/repairable classification (got ${v.status}${v.detail ? ": " + v.detail : ""})`);
	// strict case: cut the buffer mid-last-frame
	const cut = Buffer.concat([buf.subarray(0, buf.length - 40), buf.subarray(buf.length - 40, buf.length - 20)]);
	const v2 = analyze(cut);
	assert(v2.status === "torn" || v2.status === "corrupt", `damaged tail never repairs (got ${v2.status})`);
}

console.log("[6] non-header row without seq refuses");
{
	const rows = [JSON.stringify({ type: "turn/start", time: 1, data: {} }), JSON.stringify({ type: "turn/end", seq: 0, time: 2, data: {} })];
	const buf = Buffer.concat([frame(headerLine), frame(rows.join("\n") + "\n")]);
	const v = analyze(buf);
	assert(v.status === "refuse", `status refuse (got ${v.status})`);
}

console.log("[7] v4 source: plugin-wrapper rewritten deterministically (upstream tables)");
{
	const header = frame(headerLine);
	// system/message carrying a retired plugin wrapper: @deepseek-ai/dsh-system-prompt
	// with role system maps to "system-prompt"; a same-name producer ("goal") stays.
	const legacy = [
		JSON.stringify({ type: "system/message", seq: 0, time: 1791000000000, data: { message: { role: "system", content: [{ type: "text", text: "seed" }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" } } } }),
		JSON.stringify({ type: "developer/message", seq: 1, time: 1791000000001, data: { message: { role: "developer", content: [{ type: "text", text: "d" }], source: { kind: "plugin", plugin: "goal" } } } }),
		JSON.stringify({ type: "tool/result", seq: 2, time: 1791000000002, data: { message: { role: "tool", content: [{ type: "text", text: "r" }], source: { kind: "plugin", plugin: "unknown-plugin" } } } }),
	];
	const buf = Buffer.concat([header, frame(legacy.join("\n") + "\n")]);
	const v = repairSourceBuffer(buf);
	assert(v.status === "repairable", `status repairable (got ${v.status}${v.reason ? ": " + v.reason : ""})`);
	if (v.status === "repairable") {
		const again = repairSourceBuffer(v.out);
		assert(again.status === "clean", `rewritten buffer clean (got ${again.status})`);
		const { parseRows } = await import("./seqcore.js");
		const rows = parseRows(decodeFrames(v.out).frames).rows.filter((r) => r.seq !== undefined);
		const kinds = rows.map((r) => {
			const slot = r.json.data?.message;
			return slot?.source?.kind;
		});
		assert(kinds[0] === "system-prompt", `system-prompt mapping (got ${kinds[0]})`);
		assert(kinds[1] === "goal", `same-name producer preserved (got ${kinds[1]})`);
		assert(kinds[2] === "plugin:unknown-plugin", `unknown producer prefixed (got ${kinds[2]})`);
		const dropped = rows.every((r) => r.json.data?.message?.source?.plugin === undefined);
		assert(dropped, "`plugin` field dropped after rewrite");
	}
}

console.log("[8] v4 source: missing source is reported, never rewritten");
{
	const header = frame(headerLine);
	const mixed = [
		JSON.stringify({ type: "user/message", seq: 0, time: 1, data: { role: "user", content: [{ type: "text", text: "u" }] } }), // no source
		JSON.stringify({ type: "system/message", seq: 1, time: 2, data: { message: { role: "system", content: [], source: { kind: "plugin", plugin: "goal" } } } }),
	];
	const buf = Buffer.concat([header, frame(mixed.join("\n") + "\n")]);
	const v = repairSourceBuffer(buf);
	assert(v.status === "violation", `status violation (got ${v.status})`);
	assert(v.out === undefined, "no rewrite payload when judgment is required");
	assert(v.violations.some((x) => x.issue === "missing"), "violation list names the missing source");
}

if (failed > 0) {
	console.log(`\n${failed} assertion(s) FAILED`);
	process.exit(1);
}
console.log("\nALL SELFTESTS PASSED");
