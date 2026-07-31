/**
 * Minimal MCP (Model Context Protocol) client for team members.
 *
 * pi has no native MCP support — this module lets team members use MCP
 * tools by reading a project `.mcp.json`, spawning/connecting to servers,
 * and converting their tools into AgentTools.
 *
 * Supports:
 *  - stdio servers (command + args, newline-delimited JSON-RPC)
 *  - HTTP servers (streamable HTTP, POST + JSON/SSE responses)
 *
 * Tool schemas (JSON Schema) are converted to typebox schemas for AgentTool
 * parameters; unsupported schema shapes fall back to a loose object.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Type } from "typebox";

export interface McpServerConfig {
	name: string;
	/** stdio: command to spawn. */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** http / sse: URL of the MCP endpoint. */
	type?: "stdio" | "http" | "sse";
	url?: string;
}

export interface McpToolDef {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

/** JSON-RPC message shape used by MCP. */
interface McpMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string };
}

/** Load MCP servers from `<projectDir>/.mcp.json` (standard location). */
export function loadMcpServers(projectDir: string): McpServerConfig[] {
	const candidates = [
		join(projectDir, ".mcp.json"),
		join(projectDir, ".cursor", "mcp.json"),
	];
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		try {
			const raw = readFileSync(file, "utf8");
			const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
			if (!parsed.mcpServers) return [];
			return Object.entries(parsed.mcpServers)
				.map(([name, cfg]) => normalizeServerConfig(name, cfg))
				.filter((c): c is McpServerConfig => c !== null);
		} catch {
			// malformed config — skip silently
			return [];
		}
	}
	return [];
}

/**
 * Load MCP servers from global config: Claude Code's `~/.claude.json`
 * `mcpServers`, then a plain `~/.mcp.json` if present. Lets pi reuse the
 * same global MCP servers as Claude Code.
 */
export function loadGlobalMcpServers(): McpServerConfig[] {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const candidates = [join(home, ".claude.json"), join(home, ".mcp.json")];
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			const servers = parsed.mcpServers ?? parsed;
			if (typeof servers !== "object" || servers === null) continue;
			return Object.entries(servers as Record<string, unknown>)
				.map(([name, cfg]) => normalizeServerConfig(name, cfg))
				.filter((c): c is McpServerConfig => c !== null);
		} catch {
			continue;
		}
	}
	return [];
}

/** Merge project + global servers; project wins on name collision. */
export function mergeMcpServers(
	project: McpServerConfig[],
	global: McpServerConfig[],
): McpServerConfig[] {
	const byName = new Map<string, McpServerConfig>();
	for (const s of [...global, ...project]) byName.set(s.name, s);
	return [...byName.values()];
}

function normalizeServerConfig(
	name: string,
	raw: unknown,
): McpServerConfig | null {
	if (typeof raw !== "object" || raw === null) return null;
	const cfg = raw as Record<string, unknown>;
	if (typeof cfg.command === "string") {
		return {
			name,
			command: cfg.command,
			args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
			env: typeof cfg.env === "object" && cfg.env !== null
				? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)]))
				: undefined,
			type: "stdio",
		};
	}
	if (typeof cfg.url === "string") {
		return {
			name,
			type: cfg.type === "sse" ? "sse" : "http",
			url: cfg.url,
		};
	}
	return null;
}

/** One connected MCP server, exposing its tools. */
export class McpClient {
	readonly name: string;
	private proc: ChildProcess | null = null;
	private httpUrl: string | null = null;
	private pending = new Map<number, (msg: McpMessage) => void>();
	private nextId = 1;
	private closed = false;
	private toolsCache: McpToolDef[] | null = null;
	private buffer = "";
	/** Per-request timeout in ms (default 30s; shorter for best-effort global MCP). */
	private readonly timeoutMs: number;

	constructor(cfg: McpServerConfig, timeoutMs = 30000) {
		this.name = cfg.name;
		this.timeoutMs = timeoutMs;
		if (cfg.command) {
			this.proc = spawn(cfg.command, cfg.args ?? [], {
				env: cfg.env ? { ...process.env, ...cfg.env } : process.env,
				stdio: ["pipe", "pipe", "inherit"],
			});
			this.httpUrl = null;
		} else if (cfg.url) {
			this.httpUrl = cfg.url;
			this.proc = null;
		} else {
			throw new Error(`MCP server "${cfg.name}" has neither command nor url`);
		}
	}

	/** Initialize protocol and fetch the tool list. */
	async connect(): Promise<McpToolDef[]> {
		if (this.proc) {
			const rl = createInterface({ input: this.proc.stdout! });
			rl.on("line", (line) => this.handleMessage(line));
			this.proc.on("exit", () => this.failAll());
			this.proc.on("error", (e) => {
				console.error(`[team-mcp] ${this.name} spawn error: ${e.message}`);
				this.failAll();
			});
			await this.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-team-extension", version: "0.2.0" },
			});
			this.notify("notifications/initialized", {});
		} else {
			await this.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-team-extension", version: "0.2.0" },
			});
			this.notify("notifications/initialized", {});
		}
		this.toolsCache = await this.listToolsRaw();
		return this.toolsCache;
	}

	private handleMessage(line: string): void {
		if (!line.trim()) return;
		try {
			const msg = JSON.parse(line) as McpMessage;
			const msgId = typeof msg.id === "number" ? msg.id : undefined;
			if (msgId !== undefined && this.pending.has(msgId)) {
				const resolve = this.pending.get(msgId)!;
				this.pending.delete(msgId);
				resolve(msg);
			}
		} catch {
			// non-JSON line — ignore
		}
	}

	private failAll(): void {
		for (const [id, resolve] of this.pending) {
			resolve({ id, error: { code: -32000, message: "MCP server closed" } });
		}
		this.pending.clear();
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolvePromise, reject) => {
			this.pending.set(id, (msg) => {
				if (msg.error) reject(new Error(`MCP ${method}: ${msg.error.message ?? "error"}`));
				else resolvePromise(msg.result);
			});
			this.send({ jsonrpc: "2.0", id, method, params });
			// safety timeout
			setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));
				}
			}, this.timeoutMs).unref();
		});
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	private send(msg: unknown): void {
		const payload = JSON.stringify(msg);
		if (this.proc) {
			this.proc.stdin!.write(payload + "\n");
		} else {
			// HTTP: fire-and-forget notifications are dropped (no session persistence)
			void this.httpPost(msg);
		}
	}

	private async httpPost(msg: unknown): Promise<unknown> {
		if (!this.httpUrl) throw new Error("no http url");
		const res = await fetch(this.httpUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify(msg),
		});
		if (!res.ok) {
			throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
		const text = await res.text();
		// Streamable HTTP may return SSE or plain JSON.
		if (text.trim().startsWith("{")) return JSON.parse(text);
		// SSE: last event's data field
		const dataLine = text.split("\n").filter((l) => l.startsWith("data:")).pop();
		return dataLine ? JSON.parse(dataLine.slice(5)) : undefined;
	}

	private async listToolsRaw(): Promise<McpToolDef[]> {
		const result = await this.request("tools/list", {}) as {
			tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
		};
		return (result.tools ?? []).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
		}));
	}

	/** Call an MCP tool. */
	async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		const result = await this.request("tools/call", { name, arguments: args }) as {
			content?: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};
		if (result.isError) {
			const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
			throw new Error(`MCP tool ${name} error: ${text || "unknown"}`);
		}
		const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
		return text || "(empty result)";
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.proc) {
			try {
				this.send({ jsonrpc: "2.0", method: "notifications/exit" });
			} catch { /* ignore */ }
			this.proc.stdin?.end();
			this.proc.kill();
		}
		this.failAll();
	}
}

/** Convert a JSON Schema into a typebox schema (best effort). */
export function jsonSchemaToTypebox(schema: Record<string, unknown>): unknown {
	const type = schema.type;
	const desc = typeof schema.description === "string" ? { description: schema.description } : undefined;
	switch (type) {
		case "string": {
			if (Array.isArray(schema.enum)) return Type.Union(schema.enum.map((v) => Type.Literal(String(v))), desc);
			return Type.String(desc);
		}
		case "number": return Type.Number(desc);
		case "integer": return Type.Integer(desc);
		case "boolean": return Type.Boolean(desc);
		case "array": {
			const items = schema.items as Record<string, unknown> | undefined;
			return Type.Array(items ? (jsonSchemaToTypebox(items) as never) : Type.Any(), desc);
		}
		case "object": {
			const properties = (schema.properties ?? {}) as Record<string, unknown>;
			const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
			const props: Record<string, never> = {};
			for (const [key, val] of Object.entries(properties)) {
				const converted = jsonSchemaToTypebox((val ?? {}) as Record<string, unknown>);
				props[key] = required.has(key) ? (converted as never) : (Type.Optional(converted as never) as never);
			}
			return Type.Object(props, desc as never);
		}
		default:
			return Type.Any(desc);
	}
}

/** Build a pi AgentTool from an MCP tool def. */
export function mcpToolToAgentTool(
	mcp: McpClient,
	tool: McpToolDef,
): {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
} {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description ?? `MCP tool ${tool.name}`,
		parameters: jsonSchemaToTypebox(tool.inputSchema),
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const text = await mcp.callTool(tool.name, params ?? {});
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	};
}
