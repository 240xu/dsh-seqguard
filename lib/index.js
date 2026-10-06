/**
 * dsh-seqguard — background session seq integrity guard (read + repair).
 *
 * Root cause it defends against: on Termux/bionic the session write lease
 * degrades to a no-op (flock unsupported), so a seed-construction handle and
 * a stale resume handle can both append to the same session file and emit a
 * duplicate `seq`. dsh's strict validator then rejects the ENTIRE history on
 * read ("invalid committed event ... has seq gap"). Upstream report:
 * github.com/deepseek-ai/deepseek-harness discussion #8984.
 *
 * Behavior (conservative by construction):
 *   - scan `~/.dsh/sessions/<project>/<session>/session[.vN].jsonl.zstd` on an interval; files
 *     touched within idleGraceMs are skipped (still being written);
 *   - verdicts for unchanged (mtime+size) files are cached — steady state is
 *     near-free;
 *   - only the single-shift duplicate class (see lib/seqcore.js) is
 *     repairable; torn tails and unknown shapes are reported, never written;
 *   - auto-repair (opt-out) requires: no /proc fd holds the file, two stable
 *     stat samples, a side-by-side `.bak-seqguard-<ts>` backup, temp-file +
 *     rename publish (atomic on this filesystem), then re-analysis of the
 *     bytes actually written;
 *   - GET-only JSON endpoints under /seqguard (same loopback/same-origin
 *     trust gate as dsh-session-lazy-view).
 */
import z from "@deepseek-ai/schemastery";
import { readdir, stat, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { homedir } from "node:os";
import { analyze } from "./seqcore.js";
import { repairSourceBuffer } from "./sources.js";

const name = "dsh-seqguard";
const inject = ["webServer"];
const Config = z.object({
	/** Rewrite repairable files automatically (backup always taken). */
	autoRepair: z.boolean().default(true),
	/** Scan cadence in minutes. Only changed files are re-read after the first pass. */
	intervalMinutes: z.number().min(1).max(1440).default(30),
	/** Skip files whose mtime is newer than this (active writes). */
	idleGraceMs: z.number().min(1000).max(3600000).default(180000),
	/** Auto-apply the deterministic v4 source-kind rewrite (plugin-wrapper → producer kind).
	 *  Default OFF: it rewrites message attribution, so it stays opt-in even though the
	 *  mapping is canonical. Missing/invalid sources are never auto-repaired either way. */
	repairSourceKind: z.boolean().default(false),
	/** Infer the missing source of a V3-era `system/message` (role system) as
	 *  `{ kind: "system-prompt" }` — the exact shape healthy peers carry.
	 *  Evidence-backed, but it assigns attribution, so it stays opt-in. */
	inferSystemSource: z.boolean().default(false),
});

const sessionsRoot = () => join(homedir(), ".dsh", "sessions");
const ARTIFACT_RE = /^(session(\.v\d+)?\.jsonl\.zstd)$/;
const REL_PATH_RE = /^[^/]+\/session-[^/]+\/session(\.v\d+)?\.jsonl\.zstd$/;

function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
/** Same trust gate as dsh-session-lazy-view: loopback Host, no cross-site fetch, same-origin. */
function isTrusted(request) {
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/** Resolve a client-supplied relative path under the sessions root; reject escapes. */
function resolveArtifact(rel) {
	if (typeof rel !== "string" || !REL_PATH_RE.test(rel)) return null;
	const root = sessionsRoot();
	const full = normalize(join(root, rel));
	if (full !== root && !full.startsWith(root + sep)) return null;
	return full;
}

async function listArtifacts() {
	const root = sessionsRoot();
	const out = [];
	let projects;
	try {
		projects = await readdir(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const projDir = join(root, project.name);
		let sessions;
		try {
			sessions = await readdir(projDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const session of sessions) {
			if (!session.isDirectory()) continue;
			const sessionDir = join(projDir, session.name);
			let files;
			try {
				files = await readdir(sessionDir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (ARTIFACT_RE.test(file)) {
					out.push({ rel: `${project.name}/${session.name}/${file}`, path: join(sessionDir, file) });
				}
			}
		}
	}
	return out;
}

/** PIDs whose /proc/<pid>/fd symlink resolves to `target` (best-effort; own-uid only). */
async function fdHolders(target) {
	const holders = [];
	let pids;
	try {
		pids = await readdir("/proc");
	} catch {
		return holders;
	}
	for (const pid of pids) {
		if (!/^\d+$/.test(pid)) continue;
		let fds;
		try {
			fds = await readdir(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		for (const fd of fds) {
			try {
				const { readlink } = await import("node:fs/promises");
				const link = await readlink(`/proc/${pid}/fd/${fd}`);
				if (link === target) {
					holders.push(pid);
					break;
				}
			} catch {
				/* fd vanished mid-scan — fine */
			}
		}
	}
	return holders;
}

function apply(ctx, config) {
	// cordis function-plugin contract: entry config arrives as the 2nd argument
	// (validated through our exported Config schema, defaults applied), NOT as
	// ctx.config — that proxy property requires a "config" inject entry.
	const cfg = config ?? {};
	const state = {
		lastScanAt: null,
		lastError: null,
		/** path -> {mtimeMs, size, verdict} — unchanged files are not re-read. */
		cache: new Map(),
		stats: { scanned: 0, clean: 0, cached: 0, active: 0, torn: 0, corrupt: 0, refused: 0, sourceRepairable: 0, sourceViolations: 0, repaired: [] },
	};

	async function repairFile(artifact, mode = "seq") {
		const auto = cfg.autoRepair !== false;
		const now = Date.now();
		if (!auto) {
			state.stats.refused++;
			return { path: artifact.rel, status: "repairable-not-repaired", shift: verdict.shift, detail: verdict.detail, autoRepair: false };
		}
		// Triple gate before any write: (1) two stable stat samples,
		// (2) no live fd holds the file, (3) analyze() on a fresh read still
		// says repairable.
		try {
			const a = await stat(artifact.path);
			await new Promise((r) => setTimeout(r, 500));
			const b = await stat(artifact.path);
			if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) {
				state.stats.refused++;
				return { path: artifact.rel, status: "busy", reason: "mtime/size moved during repair window" };
			}
			const holders = await fdHolders(artifact.path);
			if (holders.length > 0) {
				state.stats.refused++;
				return { path: artifact.rel, status: "busy", reason: `held by pid(s) ${holders.join(",")}` };
			}
			const fresh = await readFile(artifact.path);
			const again = mode === "source" ? repairSourceBuffer(fresh, { inferSystemSource: cfg.inferSystemSource === true }) : analyze(fresh);
			if (again.status !== "repairable") {
				state.stats.refused++;
				return { path: artifact.rel, status: "changed", reason: `re-read says ${again.status}` };
			}
			const backup = `${artifact.path}.bak-seqguard-${Math.floor(now / 1000)}`;
			await copyFile(artifact.path, backup);
			const tmp = `${artifact.path}.tmp-seqguard`;
			await writeFile(tmp, again.out);
			const published = await readFile(tmp);
			const check = analyze(published);
			if (check.status !== "clean") {
				state.stats.refused++;
				return { path: artifact.rel, status: "aborted", reason: `post-write check: ${check.status}` };
			}
			await rename(tmp, artifact.path);
			state.cache.set(artifact.path, { mtimeMs: (await stat(artifact.path)).mtimeMs, size: again.out.length, verdict: "repaired" });
			const record = mode === "source"
				? { path: artifact.rel, at: new Date(now).toISOString(), mode: "source", rewritten: again.violations.length, backup: backup.split("/").pop() }
				: { path: artifact.rel, at: new Date(now).toISOString(), mode: "seq", shift: again.shift, detail: { expected: again.detail.expected, got: again.detail.got, type: again.detail.type }, backup: backup.split("/").pop() };
			state.stats.repaired.push(record);
			if (state.stats.repaired.length > 50) state.stats.repaired.shift();
			if (mode === "source") {
				console.log(`[seqguard] repaired sources ${artifact.rel}: ${again.violations.length} plugin-wrapper row(s) rewritten`);
			} else {
				console.log(`[seqguard] repaired ${artifact.rel}: shift +${again.shift} (row ${again.detail.rowIdx}, ${again.detail.got}->${again.detail.expected})`);
			}
			return { path: artifact.rel, status: "repaired", mode, backup: record.backup };
		} catch (error) {
			state.stats.refused++;
			return { path: artifact.rel, status: "error", reason: error instanceof Error ? error.message : String(error) };
		}
	}

	async function scanOnce() {
		const idleGrace = cfg.idleGraceMs ?? 180000;
		state.stats = { scanned: 0, clean: 0, cached: 0, active: 0, torn: 0, corrupt: 0, refused: 0, repaired: state.stats.repaired };
		const artifacts = await listArtifacts();
		const seen = new Set();
		const report = [];
		for (const artifact of artifacts) {
			seen.add(artifact.path);
			state.stats.scanned++;
			try {
				const info = await stat(artifact.path);
				if (Date.now() - info.mtimeMs < idleGrace) {
					state.stats.active++;
					continue;
				}
				const hit = state.cache.get(artifact.path);
				if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
					state.stats.cached++;
					continue;
				}
				const buf = await readFile(artifact.path);
				const verdict = analyze(buf);
				if (verdict.status === "clean" || verdict.status === "repairable") {
					state.cache.set(artifact.path, { mtimeMs: info.mtimeMs, size: info.size, verdict: verdict.status });
				}
				if (verdict.status === "clean") {
					state.stats.clean++;
				} else if (verdict.status === "repairable") {
					report.push(await repairFile(artifact, "seq"));
				} else if (verdict.status === "torn") {
					state.stats.torn++; // active tail or crash — dsh tolerates on read; re-check next pass
				} else if (verdict.status === "corrupt") {
					state.stats.corrupt++;
					report.push({ path: artifact.rel, status: "corrupt", reason: verdict.detail });
				} else {
					state.stats.refused++;
					report.push({ path: artifact.rel, status: "refuse", reason: verdict.reason });
				}
				// v4 message-source pass: runs on the effective buffer (seq-repaired if we
				// just rewrote it, otherwise the file as read). Deterministic rewrites are
				// opt-in; everything else is reported and never written.
				if (verdict.status === "clean" || verdict.status === "repairable") {
					const base = verdict.status === "repairable" ? verdict.out : buf;
					const sources = repairSourceBuffer(base, { inferSystemSource: cfg.inferSystemSource === true });
					if (sources.status === "repairable") {
						state.stats.sourceRepairable = (state.stats.sourceRepairable ?? 0) + 1;
						if (cfg.repairSourceKind === true) {
							report.push(await repairFile(artifact, "source"));
						} else {
							report.push({ path: artifact.rel, status: "source-repairable-not-repaired", count: sources.violations.length, autoRepairSourceKind: false });
						}
					} else if (sources.status === "violation") {
						state.stats.sourceViolations = (state.stats.sourceViolations ?? 0) + 1;
						report.push({
							path: artifact.rel,
							status: "source-violation",
							count: sources.violations.length,
							sample: sources.violations.slice(0, 5).map((v) => ({ seq: v.seq, type: v.type, issue: v.issue, plugin: v.plugin })),
						});
					}
				}
			} catch (error) {
				state.lastError = error instanceof Error ? error.message : String(error);
			}
		}
		for (const key of state.cache.keys()) if (!seen.has(key)) state.cache.delete(key);
		state.lastReport = report;
		state.lastScanAt = new Date().toISOString();
		return report;
	}

	ctx.effect(() => {
		const delay = setTimeout(() => {
			scanOnce().catch((error) => {
				state.lastError = error instanceof Error ? error.message : String(error);
			});
			const timer = setInterval(() => {
				scanOnce().catch((error) => {
					state.lastError = error instanceof Error ? error.message : String(error);
				});
			}, Math.max(1, cfg.intervalMinutes ?? 30) * 60000);
			timer.unref?.();
		}, 15000);
		delay.unref?.();
		console.log(`[seqguard] armed: autoRepair=${cfg.autoRepair !== false} repairSourceKind=${cfg.repairSourceKind === true} inferSystemSource=${cfg.inferSystemSource === true} interval=${cfg.intervalMinutes ?? 30}m`);
	}, "dsh-seqguard: scan timer");

	ctx.effect(() => ctx.get("webServer")?.register({
		kind: "prefix",
		path: "/seqguard",
		handler: async (req, res) => {
			try {
				if (!isTrusted(req)) {
					writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { ok: false, error: { code: "method", message: "GET only" } });
					return;
				}
				const url = new URL(req.url ?? "/", "http://dsh.internal");
				if (url.pathname === "/seqguard/status") {
					writeJson(res, 200, {
						ok: true,
						value: {
							name,
							autoRepair: cfg.autoRepair !== false,
							repairSourceKind: cfg.repairSourceKind === true,
							inferSystemSource: cfg.inferSystemSource === true,
							intervalMinutes: cfg.intervalMinutes ?? 30,
							idleGraceMs: cfg.idleGraceMs ?? 180000,
							lastScanAt: state.lastScanAt,
							lastError: state.lastError,
							stats: state.stats,
							report: state.lastReport ?? [],
						},
					});
					return;
				}
				if (url.pathname === "/seqguard/check" || url.pathname === "/seqguard/repair") {
					const full = resolveArtifact(url.searchParams.get("path") ?? "");
					if (full === null) {
						writeJson(res, 400, { ok: false, error: { code: "bad-path", message: "path must be <project>/session-<id>/session[.vN].jsonl.zstd under the sessions root" } });
						return;
					}
					const buf = await readFile(full).catch((e) => {
						writeJson(res, 404, { ok: false, error: { code: "not-found", message: String(e.message ?? e) } });
						return null;
					});
					if (buf === null) return;
					if (url.pathname === "/seqguard/check") {
						const verdict = analyze(buf);
						const { out, ...rest } = verdict; // repair payload not needed for check
						const base = verdict.status === "repairable" ? verdict.out : buf;
						const sources = repairSourceBuffer(base, { inferSystemSource: cfg.inferSystemSource === true });
						writeJson(res, 200, { ok: true, value: { ...rest, sources: { status: sources.status, count: sources.violations?.length ?? 0, violations: (sources.violations ?? []).slice(0, 10) } } });
						return;
					}
					const mode = url.searchParams.get("mode") === "source" ? "source" : "seq";
					const verdict = analyze(buf);
					if (mode === "seq" && verdict.status !== "repairable") {
						writeJson(res, 200, { ok: true, value: { status: verdict.status, detail: verdict.detail ?? verdict.reason ?? null } });
						return;
					}
					const result = await repairFile({ rel: url.searchParams.get("path"), path: full }, mode);
					writeJson(res, 200, { ok: true, value: result });
				}
			} catch (error) {
				writeJson(res, 500, { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
			}
		},
	}), "dsh-seqguard: /seqguard routes (integrity scan + repair)");
}

export { Config, apply, inject, name };
