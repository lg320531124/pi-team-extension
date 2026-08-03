/**
 * pi extension entry point.
 *
 * Registers:
 *  - `/team run <file.yml>` command — explicit, YAML-defined teams
 *  - `start_team` tool — natural-language team startup (the main pi model
 *    calls it when the user asks to "start an agent team")
 *
 * Discovery: package.json declares `"pi": { "extensions": ["./src/extension.ts"] }`.
 * pi's loader (core/extensions/loader.ts:readPiManifest) reads this field and
 * imports the default export, calling it with the ExtensionAPI.
 *
 * This complements the standalone `pi-team` CLI (src/cli.ts) — the extension is
 * the preferred path for pi users; the CLI is for non-pi consumers.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TeamCoordinator } from "./team/coordinator.js";
import { parseTeamYaml } from "./team/schema.js";
import { buildDefaultTeamDef } from "./team/default-team.js";
import { loadMcpServers, loadGlobalMcpServers, mergeMcpServers, McpClient, mcpToolToAgentTool } from "./team/mcp.js";
import { loadOvConfig, ovRecall, ovCapture, ovSessionId } from "./memory/openviking.js";

/** Active MCP clients per cwd (main-session injection). */
const mcpClientsByCwd = new Map<string, McpClient[]>();

/** Number of teams currently running (footer display). */
let activeTeams = 0;

/**
 * Register MCP tools from the project's .mcp.json into the main session.
 * Called on session_start so cwd is known; tools get an `mcp_<server>_<tool>`
 * name to avoid collisions. Clients close on session_shutdown.
 */
async function registerMainSessionMcpTools(pi: ExtensionAPI, cwd: string): Promise<void> {
	if (mcpClientsByCwd.has(cwd)) return; // already registered for this cwd
	const servers = mergeMcpServers(loadMcpServers(cwd), loadGlobalMcpServers());
	if (servers.length === 0) return;

	const clients: McpClient[] = [];
	const tasks = servers.map(async (cfg) => {
		// Best-effort global servers: short timeout so slow servers don't stall startup.
		const client = new McpClient(cfg, 8000);
		try {
			const tools = await client.connect();
			clients.push(client);
			for (const t of tools) {
				const name = `mcp_${cfg.name}_${t.name}`;
				const wrapped = mcpToolToAgentTool(client, t);
				pi.registerTool({
					name,
					label: `MCP: ${cfg.name}/${t.name}`,
					description: `MCP tool \`${t.name}\` from server \`${cfg.name}\` (${cwd}/.mcp.json). ${t.description ?? ""}`,
					parameters: wrapped.parameters as never,
					async execute(toolCallId: string, params: never) {
						const result = await wrapped.execute(
							toolCallId,
							(params as Record<string, unknown> | undefined) ?? {},
						);
						return result as { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
					},
				});
			}
		} catch (e) {
			console.error(
				`[team-extension] MCP server "${cfg.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
			);
			await client.close().catch(() => {});
		}
	});
	await Promise.allSettled(tasks);
	if (clients.length > 0) mcpClientsByCwd.set(cwd, clients);
}

/** Resolve the session model + API key from pi's own registry. */
async function resolveAuth(
	ctx: ExtensionContext,
): Promise<{ ok: true; model: Model<any>; apiKey: string } | { ok: false; error: string }> {
	const model = ctx.model;
	if (!model) {
		return { ok: false, error: "No model selected. Use /model to pick one first." };
	}
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) return { ok: true, model, apiKey: auth.apiKey ?? "" };
		return {
			ok: false,
			error: `No API key for provider "${model.provider}": ${auth.error ?? "unknown"}`,
		};
	} catch (e) {
		return {
			ok: false,
			error: `Auth resolution failed: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

/** modelResolver: split "provider/id"; bare ids prefer the session provider. */
function makeModelResolver(ctx: ExtensionContext): (id: string) => Model<any> | undefined {
	return (id: string) => {
		const slashIdx = id.indexOf("/");
		if (slashIdx >= 0) {
			const provider = id.slice(0, slashIdx);
			const modelId = id.slice(slashIdx + 1);
			return ctx.modelRegistry.find(provider, modelId);
		}
		// Bare id: prefer the current session's provider (same id may exist under
		// multiple providers, e.g. "deepseek-v4-flash" under opencode-go and deepseek).
		const currentProvider = ctx.model?.provider;
		if (currentProvider) {
			const same = ctx.modelRegistry.find(currentProvider, id);
			if (same) return same;
		}
		for (const m of ctx.modelRegistry.getAll()) {
			if (m.id === id) return m;
		}
		return undefined;
	};
}

function toolOk(text: string) {
	return { content: [{ type: "text", text } as const], details: { ok: true } };
}

const startTeamSchema = Type.Object({
	goal: Type.String({
		description: "团队要自主完成的目标（尽量具体，包含范围和要求）",
	}),
	workers: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'worker 角色列表，默认 ["coder","reviewer"]；可选 coder / reviewer / tester / writer',
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "模型 ID（可选，默认使用当前会话模型，例如 'deepseek-v4-flash'）",
		}),
	),
});

function toolError(error: string) {
	return {
		content: [{ type: "text", text: `❌ ${error}` } as const],
		details: { ok: false, error },
	};
}

/** Run a coordinator to completion, wiring UI events + abort handling. */
async function runTeam(
	coordinator: TeamCoordinator,
	teamName: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string> {
	// safeNotify/safeStatus swallow stale-ctx errors — events may fire after
	// the invoking turn ends (print mode, session replacement).
	const safeNotify = (type: "info" | "warning" | "error", msg: string) => {
		try { ctx.ui.notify(msg, type); } catch { /* ctx may be stale */ }
	};
	const safeStatus = (text: string | undefined) => {
		try { ctx.ui.setStatus("team", text); } catch { /* ctx may be stale */ }
	};

	coordinator.on("message", (m) => {
		safeNotify("info", `[${m.from} → ${m.to}] ${m.content.slice(0, 120)}`);
	});
	coordinator.on("agent_done", (name) => {
		safeNotify("info", `✓ ${name} done`);
		const live = coordinator
			.getMemberSummaries()
			.map((m) => `${m.name}:${m.status}`)
			.join(", ");
		safeStatus(`teams×${activeTeams} ▶ ${live}`);
	});
	coordinator.on("agent_error", (name, err) => {
		safeNotify("error", `✗ ${name}: ${err}`);
	});
	coordinator.on("team_done", () => {
		safeNotify("info", "team complete");
	});

	activeTeams += 1;
	safeNotify("info", `Starting team "${teamName}"…`);
	safeStatus(`teams×${activeTeams} ▶ ${teamName} starting…`);

	const onAbort = () => {
		void coordinator.stop();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await coordinator.start();
		await coordinator.waitForCompletion();
	} catch (e) {
		throw e;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		activeTeams = Math.max(0, activeTeams - 1);
		safeStatus(undefined);
		// Always tear down agent timers + leftover worktrees so the process can exit.
		await coordinator.stop().catch(() => {});
	}
	if (signal?.aborted) {
		return "⛔ 团队运行被中断。worktree 已按贡献状态处理：有提交的分支保留待 merge，干净的分支已清理。";
	}
	return formatTeamResult(coordinator);
}

/** Human-readable team result: member outputs, merges, task board. */
function formatTeamResult(coordinator: TeamCoordinator): string {
	const state = coordinator.getState();
	const members = coordinator.getMemberSummaries();
	const merges = coordinator.getResults();
	const lines: string[] = [];
	lines.push(`团队 "${state?.name ?? "?"}" 运行完成。`);
	if (members.length > 0) {
		lines.push("", "成员产出：");
		for (const m of members) {
			const role = m.isLeader ? "leader" : "worker";
			const preview = m.summary.length > 160 ? `${m.summary.slice(0, 160)}…` : m.summary;
			lines.push(`- ${m.name} (${role}, ${m.status}): ${preview}`);
		}
	}
	if (merges.length > 0) {
		lines.push("", "代码归集（已 merge 回主分支）：");
		for (const r of merges) {
			if (r.error) {
				lines.push(`- ${r.name}: merge 失败 — ${r.error}`);
			} else {
				lines.push(`- ${r.name}: commit ${r.hash?.slice(0, 8)} — ${r.message ?? ""}`);
			}
		}
	}
	const tasks = state?.tasks ?? [];
	if (tasks.length > 0) {
		lines.push("", "任务板终态：");
		for (const t of tasks) {
			lines.push(
				`- ${t.id} [${t.status}]${t.assignedTo ? ` @${t.assignedTo}` : ""}: ${t.title}`,
			);
		}
	}
	return lines.join("\n");
}

export default function teamExtension(pi: ExtensionAPI): void {
	// Main-session MCP injection: connect project .mcp.json servers and expose
	// their tools to the main agent. Runs on session start (cwd known), closes
	// on shutdown. Failures are silent — MCP is best-effort.
	pi.on("session_start", (event, ctx) => {
		// Await (per-server 8s cap) so MCP tools are registered before the first turn.
		return registerMainSessionMcpTools(pi, ctx.cwd).catch(() => {});
	});
	pi.on("session_shutdown", () => {
		const all = [...mcpClientsByCwd.values()].flat();
		mcpClientsByCwd.clear();
		void Promise.allSettled(all.map((c) => c.close().catch(() => {})));
	});

	// OpenViking long-term memory: recall relevant memories before each turn,
	// capture the turn afterwards. Both are best-effort with short timeouts —
	// memory failures must never slow down or break the conversation.
	const ovCfg = loadOvConfig();
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ovCfg.enabled) return;
		const memory = await ovRecall(ovCfg, (event.prompt ?? "").slice(0, 200));
		if (!memory) return;
		return {
			message: {
				customType: "ov-memory",
				// NOTE: pi places this message AFTER the user's prompt in the
				// conversation (see agent-session.js emitBeforeAgentStart usage).
				// It must be framed as non-actionable reference context, otherwise
				// the model may treat it as a follow-up user input and reply to it
				// instead of answering the actual question.
				content:
					"[长期记忆] 以下是从历史会话检索到的参考记忆（按相关性排序，可能含噪声）。" +
					"它不是用户的新输入，无需回应它；仅当与当前问题直接相关时作为背景参考：\n" +
					memory,
				display: true,
			},
		};
	});
	pi.on("turn_end", (event, ctx) => {
		if (!ovCfg.enabled) return;
		// AgentMessage is a union; only some variants carry text content.
		const content = (event.message as { content?: unknown }).content;
		const text = Array.isArray(content)
			? content.map((c) => (c.type === "text" ? c.text : "")).join(" ")
			: typeof content === "string"
				? content
				: "";
		void ovCapture(ovCfg, ovSessionId(ctx.cwd), text.slice(0, 2000), text.slice(0, 2000)).catch(() => {});
	});

	pi.registerCommand("team", {
		description: "Agent team coordination. Usage: /team run <file.yml>",
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			if (sub !== "run") {
				ctx.ui.notify("Usage: /team run <file.yml>", "warning");
				return;
			}
			const yamlArg = rest[0];
			if (!yamlArg) {
				ctx.ui.notify("Usage: /team run <file.yml> — missing YAML path", "warning");
				return;
			}
			const yamlPath = resolve(ctx.cwd, yamlArg);

			let content: string;
			try {
				content = await readFile(yamlPath, "utf8");
			} catch (e) {
				ctx.ui.notify(
					`Cannot read ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
				return;
			}

			let teamDef;
			try {
				teamDef = await parseTeamYaml(content);
			} catch (e) {
				ctx.ui.notify(
					`Parse error: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
				return;
			}

			const auth = await resolveAuth(ctx);
			if (!auth.ok) {
				ctx.ui.notify(auth.error, "error");
				return;
			}

			const coordinator = new TeamCoordinator(
				teamDef,
				{
					apiKey: auth.apiKey,
					defaultModel: `${auth.model.provider}/${auth.model.id}`,
					cwd: ctx.cwd,
					mcpServers: loadMcpServers(ctx.cwd),
				},
				makeModelResolver(ctx),
			);

			await runTeam(coordinator, teamDef.name, ctx);
		},
	});

	pi.registerTool({
		name: "start_team",
		label: "Start Agent Team",
		description:
			"启动一个 agent 团队（architect 领导 + 若干 worker）自主完成一个目标。适合多步骤、多文件、需要独立验证的任务。" +
			"leader 会自动分解目标为任务、分配给 worker、协调并汇总。团队运行期间会阻塞等待（类似长命令）；完成后 worker 的代码改动自动 merge 回主分支。" +
			"目标描述得越具体越好，例如：'为项目添加用户登录功能，包括前后端'。",
		parameters: Type.Object({
			goal: Type.String({
				description: "团队要自主完成的目标（尽量具体，包含范围和要求）",
			}),
			workers: Type.Optional(
				Type.Array(
					Type.String(),
					{
						description:
							'worker 角色列表，默认 ["coder","reviewer"]；可选 coder / reviewer / tester / writer',
					},
				),
			),
			model: Type.Optional(
				Type.String({
					description: "模型 ID（可选，默认使用当前会话模型，例如 'deepseek-v4-flash'）",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Static<typeof startTeamSchema>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const auth = await resolveAuth(ctx);
			if (!auth.ok) return toolError(auth.error);

			const teamDef = buildDefaultTeamDef({
				goal: params.goal,
				workers: params.workers,
				model: params.model,
			});
			if (Object.keys(teamDef.workers).length === 0) {
				return toolError("未识别的 worker 角色。支持: coder, reviewer, tester, writer。");
			}

			const coordinator = new TeamCoordinator(
				teamDef,
				{
					apiKey: auth.apiKey,
					defaultModel:
						params.model && params.model.includes("/")
							? params.model
							: `${auth.model.provider}/${params.model ?? auth.model.id}`,
					cwd: ctx.cwd,
					mcpServers: mergeMcpServers(loadMcpServers(ctx.cwd), loadGlobalMcpServers()),
				},
				makeModelResolver(ctx),
			);

			const result = await runTeam(coordinator, teamDef.name, ctx, signal);
			return toolOk(result);
		},
	});
}
