/**
 * OpenViking memory integration for pi.
 *
 * OpenViking ("Context Database for AI Agents") provides long-term semantic
 * memory via a local REST server (default http://127.0.0.1:1933). Claude Code
 * uses it through a hooks plugin; this module gives pi the same capability:
 *  - recall: search relevant past memories for the current prompt
 *  - capture: append conversation turns to a session and commit them
 *
 * Config: env OPENVIKING_URL / OPENVIKING_API_KEY win; otherwise
 * ~/.openviking/ovcli.conf ({ url, api_key }). Disable with
 * OPENVIKING_MEMORY_ENABLED=0.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface OvConfig {
	url: string;
	apiKey: string;
	enabled: boolean;
	/** Minimum relevance score for recalled memories (0–1). */
	scoreThreshold: number;
	/** Max number of memory items recalled per turn. */
	recallLimit: number;
	/** Max characters per recalled memory preview. */
	maxContentChars: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

/** Recall is skipped for this long after a failed OpenViking request (circuit breaker). */
const CIRCUIT_BREAKER_MS = 30_000;

/** Timestamp of the last failed recall; 0 = healthy. */
let recallFailureAt = 0;

function recallCircuitOpen(): boolean {
	return recallFailureAt !== 0 && Date.now() - recallFailureAt < CIRCUIT_BREAKER_MS;
}

function clamp01(n: number): number {
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.4;
}

function toIntEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

/** Resolve OpenViking connection config (env first, then ovcli.conf). */
export function loadOvConfig(): OvConfig {
	const enabledRaw = process.env.OPENVIKING_MEMORY_ENABLED;
	const scoreThreshold = clamp01(Number(process.env.OPENVIKING_SCORE_THRESHOLD ?? "0.4"));
	const recallLimit = toIntEnv(process.env.OPENVIKING_RECALL_LIMIT, 3, 1, 10);
	const maxContentChars = toIntEnv(process.env.OPENVIKING_RECALL_MAX_CONTENT_CHARS, 300, 0, 2000);
	if (enabledRaw !== undefined && ["0", "false", "no"].includes(enabledRaw.toLowerCase())) {
		return { url: "", apiKey: "", enabled: false, scoreThreshold, recallLimit, maxContentChars };
	}

	let url = process.env.OPENVIKING_URL ?? process.env.OPENVIKING_BASE_URL ?? "";
	let apiKey = process.env.OPENVIKING_API_KEY ?? process.env.OPENVIKING_BEARER_TOKEN ?? "";

	if (!url || !apiKey) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		const confPath =
			process.env.OPENVIKING_CLI_CONFIG_FILE ??
			process.env.OPENVIKING_CONFIG_FILE ??
			join(home, ".openviking", "ovcli.conf");
		if (existsSync(confPath)) {
			try {
				const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
					url?: string;
					api_key?: string;
					apiKey?: string;
				};
				url = url || conf.url || "";
				apiKey = apiKey || conf.api_key || conf.apiKey || "";
			} catch {
				// malformed config — fall through with env-only values
			}
		}
	}

	return { url: url.replace(/\/+$/, ""), apiKey, enabled: url.length > 0, scoreThreshold, recallLimit, maxContentChars };
}

async function ovFetch(
	cfg: OvConfig,
	path: string,
	init?: RequestInit,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number; result?: unknown; error?: string }> {
	if (!cfg.enabled) return { ok: false, error: "OpenViking disabled" };
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetch(`${cfg.url}${path}`, {
			...init,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.apiKey}`,
				...(init?.headers ?? {}),
			},
			signal: controller.signal,
		});
		clearTimeout(timer);
		const text = await res.text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = text;
		}
		const body = (parsed ?? {}) as { result?: unknown; error?: unknown };
		if (!res.ok) {
			return { ok: false, status: res.status, error: String(body.error ?? res.statusText) };
		}
		return { ok: true, status: res.status, result: body.result ?? body };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Recall relevant memories for a query. Returns a formatted text block
 * (empty string when nothing found or the server is down).
 */
export async function ovRecall(
	cfg: OvConfig,
	query: string,
	limit?: number,
): Promise<string> {
	const trimmed = query.trim();
	if (!trimmed || trimmed.length < 5) return "";
	if (recallCircuitOpen()) return ""; // server recently failed — don't stall the turn

	const recallLimit = limit ?? cfg.recallLimit;
	const res = await ovFetch(cfg, "/api/v1/search/find", {
		method: "POST",
		body: JSON.stringify({
			query: trimmed,
			target_uri: "viking://user",
			limit: recallLimit,
			score_threshold: cfg.scoreThreshold,
		}),
	}, 4000);
	if (!res.ok || !Array.isArray(res.result)) {
		recallFailureAt = Date.now();
		return "";
	}
	recallFailureAt = 0;

	const items = res.result as Array<{ uri?: string; abstract?: string; overview?: string }>;
	const blocks: string[] = [];
	for (const item of items.slice(0, recallLimit)) {
		const preview = (item.abstract ?? item.overview ?? "").trim();
		if (preview.length > 0) blocks.push(`- ${preview.slice(0, cfg.maxContentChars)}`);
	}
	return blocks.length > 0 ? blocks.join("\n") : "";
}

/**
 * Capture a conversation turn into the OpenViking session and commit.
 * sessionId is a stable per-project id so memories accumulate across sessions.
 */
export async function ovCapture(
	cfg: OvConfig,
	sessionId: string,
	userText: string,
	assistantText: string,
): Promise<void> {
	if (!cfg.enabled || !userText.trim()) return;
	const sid = encodeURIComponent(sessionId);
	if (userText.trim()) {
		await ovFetch(cfg, `/api/v1/sessions/${sid}/messages?auto_create=true`, {
			method: "POST",
			body: JSON.stringify({ role: "user", content: userText.slice(0, 2000) }),
		}, 4000);
	}
	if (assistantText.trim()) {
		await ovFetch(cfg, `/api/v1/sessions/${sid}/messages?auto_create=true`, {
			method: "POST",
			body: JSON.stringify({ role: "assistant", content: assistantText.slice(0, 3000) }),
		}, 4000);
	}
	await ovFetch(cfg, `/api/v1/sessions/${sid}/commit`, { method: "POST" }, 4000);
}

/** Health check (fast fail for status display). */
export async function ovHealthy(cfg: OvConfig): Promise<boolean> {
	const res = await ovFetch(cfg, "/health", {}, 1500);
	return res.ok;
}

/** Stable session id per project dir: `pi-<cwdHash>`. */
export function ovSessionId(cwd: string): string {
	let hash = 0;
	for (let i = 0; i < cwd.length; i++) {
		hash = (hash * 31 + cwd.charCodeAt(i)) | 0;
	}
	return `pi-${(hash >>> 0).toString(36)}`;
}
