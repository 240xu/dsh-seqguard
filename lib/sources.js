/**
 * dsh-seqguard — v4 message-source guard (pure; mirrors upstream rules).
 *
 * Upstream rule (dsh-session-format-v3-to-v4): every message in a *declared
 * durable message slot* must carry a producer-owned `source`:
 *   `source` is an object, `source.kind` is a non-empty string, and
 *   `source.kind !== "plugin"`  (retired V3 plugin wrappers are refused).
 * When a session carries legacy V3 rows, the v3→v4 migration runs over them and
 * a single offending message rejects the whole log:
 *   "format v4 message requires a producer-owned source kind".
 *
 * Repair policy (split by how well-defined the fix is):
 *   - `plugin` kind with a string `plugin` field → DETERMINISTIC: upstream
 *     publishes the exact mapping (producerKind + rename/same-name tables), so
 *     we rewrite the kind and drop the `plugin` field. Safe to auto-apply.
 *   - missing / non-string / empty kind → NOT deterministic: upstream throws
 *     rather than guess, and a native V4 message may legitimately carry no
 *     source at all (assistant/message). Report only; never auto-write.
 */
import { zstdCompressSync } from "node:zlib";
import { decodeFrames, parseRows } from "./seqcore.js";

/** Upstream RENAMED_PRODUCERS: released V3 plugins whose producer kind changed. */
export const RENAMED_PRODUCERS = Object.freeze({
	"compact": "compact-checkpoint",
	"tools-code-mode": "ptc-mode",
	"tools-ptc": "ptc-mode",
	"dsh-compaction-basic": "compact-basic",
	"@deepseek-ai/dsh-system-prompt": "runtime-context",
});
/** Upstream RELEASED_SAME_NAME_PRODUCERS: first-party plugins that keep their kind. */
export const RELEASED_SAME_NAME_PRODUCERS = new Set([
	"agent-instructions", "session-reference", "team-message", "goal",
	"skill-invocation", "skill-catalog", "coordinator", "subagent-report",
	"subagent-settled", "webhook", "agent-message", "model-selection",
	"plan-mode", "time-context", "tmux-context", "user-approval",
	"repeat-tool-reminder", "tool-cordis", "cordis-host-runner", "tool-goal",
	"tool-jobs", "hooks-codex", "hooks-claude-code", "schedule",
	"dsh-session-title-llm",
]);

/** Faithful port of upstream producerKind(plugin, role). */
export function producerKind(plugin, role) {
	if (plugin === "@deepseek-ai/dsh-system-prompt" && role === "system") return "system-prompt";
	const renamed = Object.hasOwn(RENAMED_PRODUCERS, plugin) ? RENAMED_PRODUCERS[plugin] : undefined;
	if (renamed !== undefined) return renamed;
	if (RELEASED_SAME_NAME_PRODUCERS.has(plugin)) return plugin;
	return `plugin:${plugin}`;
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the declared durable message slots of one event (mirrors upstream
 * mapEventMessages): which fields carry validated message objects.
 * @returns {Array<{message: object}>}
 */
export function messageSlots(event) {
	const data = event?.data;
	if (!isObject(data)) return [];
	if (event.type === "user/message") return [{ message: data }];
	if (event.type === "developer/message" || event.type === "system/message" || event.type === "assistant/message" || event.type === "tool/result") {
		return isObject(data.message) ? [{ message: data.message }] : [];
	}
	const key = event.type === "agent/inbox/spliced" ? "inserted" : event.type === "session/title-llm-request" ? "messages" : undefined;
	if (key === undefined || !Array.isArray(data[key])) return [];
	return data[key].filter(isObject).map((message) => ({ message }));
}

/**
 * Upstream source() admission, minus the throw — plus one tolerance that the
 * raw rule does not express: a NATIVE v4 `assistant/message` carries no source
 * at all and loads fine (verified against healthy sessions), and the strict
 * rule only rejects rows on the V3→V4 migration path. Flagging those would make
 * every healthy session look broken, so assistant messages are tolerated.
 *
 * @param message - one message object from a declared durable slot.
 * @param type - enclosing event type (needed for the assistant tolerance).
 * @returns null when acceptable, else an issue code.
 */
export function sourceIssue(message, type) {
	const value = message?.source;
	const absent = !isObject(value);
	if (absent && type === "assistant/message") return null; // native shape
	if (absent) return "missing";
	if (typeof value.kind !== "string") return "non-string-kind";
	if (value.kind.length === 0) return "empty-kind";
	if (value.kind === "plugin") return typeof value.plugin === "string" ? "plugin-wrapper" : "plugin-non-canonical";
	return null;
}

/**
 * Scan parsed rows for message-source violations.
 * @returns {Array<{rowIdx, seq, type, role, issue, plugin?, repairable: boolean}>}
 */
export function scanSources(rows) {
	const out = [];
	rows.forEach((row, rowIdx) => {
		if (row.json === null) return;
		for (const slot of messageSlots(row.json)) {
			const issue = sourceIssue(slot.message, row.json?.type);
			if (issue === null) continue;
			// A system seed message with no source is the classic V3-era shape; healthy
			// peers carry exactly { kind: "system-prompt" }, so the inference is
			// evidence-backed rather than a guess — still gated by inferSystemSource.
			const inferable = issue === "missing" && row.json?.type === "system/message" && slot.message?.role === "system";
			out.push({
				rowIdx,
				seq: row.json?.seq,
				type: row.json?.type,
				role: slot.message?.role,
				issue,
				inferable,
				plugin: typeof slot.message?.source?.plugin === "string" ? slot.message.source.plugin : undefined,
				repairable: issue === "plugin-wrapper",
			});
		}
	});
	return out;
}

/**
 * Analyze a session buffer for source violations and, when every violation is a
 * deterministic plugin-wrapper rewrite, build the repaired buffer. Frame
 * boundaries are preserved (frame-0 header and untouched frames reuse raw
 * bytes); the result is re-scanned and required to come back clean.
 *
 * @returns
 *   {status:'clean', violations: []}
 *   {status:'repairable', violations, out}
 *   {status:'violation', violations, reason?}   — needs judgment; never written
 */
export function repairSourceBuffer(buf, options) {
	const inferSystemSource = options?.inferSystemSource === true;
	const { frames, decompressErrors } = decodeFrames(buf);
	if (frames.length === 0 || decompressErrors > 0) {
		return { status: "violation", violations: [], reason: "frame decode failed — not analyzable for sources" };
	}
	const { rows, errors } = parseRows(frames);
	if (errors.length > 0) return { status: "violation", violations: [], reason: errors[0] };
	const violations = scanSources(rows);
	if (violations.length === 0) return { status: "clean", violations: [] };
	const allowed = (v) => v.repairable || (inferSystemSource && v.inferable);
	if (!violations.every(allowed)) return { status: "violation", violations };

	const out = [];
	for (const frame of frames) {
		const text = frame.text;
		const outLines = [];
		let dirty = false;
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			const json = JSON.parse(line);
			let lineDirty = false;
			for (const slot of messageSlots(json)) {
				const issue = sourceIssue(slot.message, json?.type);
				if (issue === "plugin-wrapper") {
					const source = slot.message.source;
					const kind = producerKind(source.plugin, slot.message.role);
					slot.message.source = Object.keys(source).length === 2
						? { kind }
						: Object.fromEntries(Object.entries(source).filter(([k]) => k !== "plugin").map(([k, v]) => [k, k === "kind" ? kind : v]));
					lineDirty = true;
				} else if (inferSystemSource && issue === "missing" && json?.type === "system/message" && slot.message?.role === "system") {
					slot.message.source = { kind: "system-prompt" };
					lineDirty = true;
				}
			}
			dirty = dirty || lineDirty;
			outLines.push(lineDirty ? JSON.stringify(json) : line);
		}
		out.push(dirty ? zstdCompressSync(Buffer.from(outLines.join("\n") + "\n")) : frame.raw);
	}
	const repaired = Buffer.concat(out);
	const recheck = repairSourceBuffer(repaired, options);
	if (recheck.status !== "clean") {
		return { status: "violation", violations, reason: `self-validation failed: ${recheck.status}` };
	}
	return { status: "repairable", violations, out: repaired };
}
