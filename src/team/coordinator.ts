/**
 * TeamCoordinator: spawns leader + workers, wires mailboxes, runs concurrently.
 *
 * Reuses pi-native primitives only:
 *  - Agent (via TeamAgentSession)
 *  - createBashTool/createReadTool/... for builtin tools
 *  - GitWorktree for per-worker isolation
 *
 * No oh-my-pi dependency. No runSubprocess(). No AgentSession.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { Mailbox } from "./mailbox.js";
import { MessageBus } from "./message-bus.js";
import { TeamAgentSession } from "./session.js";
import { createBroadcastTool } from "./tools/broadcast.js";
import { createSendMessageTool } from "./tools/send-message.js";
import { createTeamTasksTool } from "./tools/team-tasks.js";
import type {
	AgentHandle,
	AgentStatus,
	TeamConfig,
	TeamDefinition,
	TeamState,
	TeamTask,
} from "./types.js";
import { GitWorktree } from "./worktree.js";
import { McpClient, mcpToolToAgentTool } from "./mcp.js";
import type { McpServerConfig } from "./mcp.js";
import type { AgentTool as McpAgentTool } from "@earendil-works/pi-agent-core";

const exec = promisify(execFile);

export interface CoordinatorEvents {
	message: (msg: { from: string; to: string; content: string }) => void;
	agent_done: (name: string) => void;
	agent_error: (name: string, error: string) => void;
	team_done: () => void;
}

export class TeamCoordinator extends EventEmitter {
	private state: TeamState | undefined;
	private readonly teamDef: TeamDefinition;
	private readonly config: Required<TeamConfig>;
	private readonly modelResolver: (id: string) => Model<any> | undefined;
	private _completionPromise: Promise<void> | null = null;
	/** Serializes git merges back into the main branch (git locks the index). */
	private mergeChain: Promise<void> = Promise.resolve();
	private readonly mergeResults = new Map<
		string,
		{ branch: string; hash?: string; message?: string; error?: string }
	>();
	private mcpClients: McpClient[] = [];
	private mcpTools: McpAgentTool<any>[] = [];

	constructor(
		teamDef: TeamDefinition,
		config: TeamConfig,
		modelResolver: (id: string) => Model<any> | undefined,
	) {
		super();
		this.teamDef = teamDef;
		this.config = {
			apiKey: config.apiKey,
			defaultModel: config.defaultModel,
			cwd: config.cwd,
			repoRoot: config.repoRoot ?? config.cwd,
			mailboxCapacity: config.mailboxCapacity ?? 10,
			maxMessagesPerAgent: config.maxMessagesPerAgent ?? 200,
			pollIntervalMs: config.pollIntervalMs ?? 500,
			mcpServers: config.mcpServers ?? [],
		};
		this.modelResolver = modelResolver;
	}

	async start(): Promise<TeamState> {
		const bus = new MessageBus();
		const tasks: TeamTask[] = [];
		const startedAt = Date.now();

		// Connect MCP servers and collect their tools (shared across members).
		await this.connectMcpServers();

		// Leader handle first (registered first so workers can find it).
		const leaderHandle: AgentHandle = { name: this.teamDef.leader.name, status: "pending" };
		const workers = new Map<string, AgentHandle>();
		for (const wName of Object.keys(this.teamDef.workers)) {
			workers.set(wName, { name: wName, status: "pending" });
		}
		this.state = {
			name: this.teamDef.name,
			leader: leaderHandle,
			workers,
			messages: [],
			tasks,
			startedAt,
		};

		// Wire mailboxes for everyone first (so send_message validation works).
		const leaderMailbox = new Mailbox({
			teamName: this.teamDef.name,
			agentName: this.teamDef.leader.name,
			capacity: this.config.mailboxCapacity,
		});
		bus.register(this.teamDef.leader.name, leaderMailbox);
		const workerMailboxes = new Map<string, Mailbox>();
		for (const wName of Object.keys(this.teamDef.workers)) {
			const mb = new Mailbox({
				teamName: this.teamDef.name,
				agentName: wName,
				capacity: this.config.mailboxCapacity,
			});
			workerMailboxes.set(wName, mb);
			bus.register(wName, mb);
		}

		bus.on("message", (msg) => this.emit("message", msg));

		const roster = bus.roster();

		// Build leader session.
		const leaderModel = this.resolveModel(this.teamDef.leader.model);
		const leaderSession = new TeamAgentSession({
			name: this.teamDef.leader.name,
			isLeader: true,
			role: this.teamDef.leader.role,
			task:
				this.teamDef.leader.task ??
				"Decompose the goal into tasks and dispatch them to workers.",
			model: leaderModel,
			...(this.teamDef.leader.thinkingLevel
				? { thinkingLevel: this.teamDef.leader.thinkingLevel }
				: {}),
			builtinTools: this.builtinTools(this.config.cwd),
			teamTools: this.teamTools(this.teamDef.leader.name, bus, tasks, true),
			mailbox: leaderMailbox,
			messageBus: bus,
			apiKey: this.config.apiKey,
			teamMemberNames: roster,
			cwd: this.config.cwd,
			pollIntervalMs: this.config.pollIntervalMs,
			maxMessagesPerAgent: this.config.maxMessagesPerAgent,
		});
		leaderHandle.session = leaderSession;
		leaderHandle.mailbox = leaderMailbox;
		leaderHandle.status = "running";

		// Build worker sessions (each in its own worktree if enabled).
		const workerRuns: Promise<void>[] = [];
		for (const [wName, wDef] of Object.entries(this.teamDef.workers)) {
			const mb = workerMailboxes.get(wName)!;
			const handle = workers.get(wName)!;

			let workerCwd = this.config.cwd;
			if (wDef.worktree !== false) {
				try {
					// Reuse a worktree left by a previous run; otherwise create fresh.
					const existing = await GitWorktree.find({
						repoRoot: this.config.repoRoot,
						name: wName,
					});
					const wt =
						existing ??
						(await GitWorktree.create({
							repoRoot: this.config.repoRoot,
							name: wName,
						}));
					handle.worktree = wt;
					workerCwd = wt.path;
				} catch (e) {
					// Worktree creation can fail if cwd isn't a git repo. Fall back to
					// shared cwd with a warning rather than crashing the whole team.
					this.emit(
						"agent_error",
						wName,
						`worktree creation failed (${e instanceof Error ? e.message : String(e)}); using shared cwd`,
					);
				}
			}

			const workerModel = this.resolveModel(wDef.model);
			const session = new TeamAgentSession({
				name: wName,
				isLeader: false,
				role: wDef.role,
				task: wDef.task,
				model: workerModel,
				...(wDef.thinkingLevel ? { thinkingLevel: wDef.thinkingLevel } : {}),
				builtinTools: this.builtinTools(workerCwd),
				teamTools: this.teamTools(wName, bus, tasks, false),
				mailbox: mb,
				messageBus: bus,
				apiKey: this.config.apiKey,
				teamMemberNames: roster,
				cwd: workerCwd,
				pollIntervalMs: this.config.pollIntervalMs,
				maxMessagesPerAgent: this.config.maxMessagesPerAgent,
			});
			handle.session = session;
			handle.mailbox = mb;
			handle.status = "running";

			workerRuns.push(this.runAgent(wName, session));
		}

		// Run leader + workers concurrently. Each session.start() resolves when
		// that agent's ReAct loop completes (or errors). team_done fires only
		// after all contribution merges have been serialized back to main.
		const all = [this.runAgent(this.teamDef.leader.name, leaderSession), ...workerRuns];
		this._completionPromise = Promise.allSettled(all).then(async () => {
			await this.mergeChain;
			this.emit("team_done");
		});

		return this.state;
	}

	private async runAgent(name: string, session: TeamAgentSession): Promise<void> {
		try {
			await session.start();
			const handle = this.handleFor(name);
			if (handle) handle.status = "done";
			this.emit("agent_done", name);
			await this.finalizeWorktree(name, handle);
		} catch (e) {
			const handle = this.handleFor(name);
			if (handle) handle.status = "error";
			const msg = e instanceof Error ? e.message : String(e);
			this.emit("agent_error", name, msg);
		}
	}

	/**
	 * Classify the worker's worktree contribution after the agent finishes:
	 *  - clean       → remove the worktree
	 *  - contributed → queue a serialized merge of the branch back into main
	 *  - modified    → preserve + warn (uncommitted changes must not be lost)
	 */
	private async finalizeWorktree(
		name: string,
		handle: AgentHandle | undefined,
	): Promise<void> {
		const wt = handle?.worktree as GitWorktree | undefined;
		if (!wt) return;
		try {
			const state = await wt.contributionState();
			if (state === "clean") {
				await wt.cleanup();
				handle!.worktree = undefined;
			} else if (state === "contributed") {
				this.enqueueMerge(name, handle!, wt);
			} else {
				this.emit(
					"agent_error",
					name,
					`worktree has uncommitted changes — preserved at ${wt.path} (branch ${wt.branch})`,
				);
			}
		} catch (e) {
			this.emit(
				"agent_error",
				name,
				`worktree finalization failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	/** Serialize merges: git locks the index, concurrent merges would conflict. */
	private enqueueMerge(name: string, handle: AgentHandle, wt: GitWorktree): void {
		this.mergeChain = this.mergeChain.then(async () => {
			try {
				const commit = await wt.lastCommit();
				if (!commit) {
					// No commits relative to baseline after all — nothing to merge.
					await wt.cleanup();
					handle.worktree = undefined;
					return;
				}
				await exec(
					"git",
					["merge", "--no-ff", wt.branch, "-m", `team: merge ${name} contribution`],
					{ cwd: this.config.repoRoot },
				);
				this.mergeResults.set(name, {
					branch: wt.branch,
					hash: commit.hash,
					message: commit.message,
				});
				// Merged into main — the worktree (and branch) are consumed.
				await wt.cleanup(true);
				handle.worktree = undefined;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.mergeResults.set(name, { branch: wt.branch, error: msg });
				this.emit(
					"agent_error",
					name,
					`merge of branch ${wt.branch} into main failed: ${msg} — branch preserved at ${wt.path}`,
				);
			}
		});
	}

	private handleFor(name: string): AgentHandle | undefined {
		if (!this.state) return undefined;
		if (this.state.leader.name === name) return this.state.leader;
		return this.state.workers.get(name);
	}

	private resolveModel(id: string | undefined): Model<any> {
		const target = id ?? this.config.defaultModel;
		const m = this.modelResolver(target);
		if (!m) {
			throw new Error(
				`Could not resolve model "${target}". Provide a modelResolver that returns a Model for this id.`,
			);
		}
		return m;
	}

	/** pi builtin file/shell tools, scoped to a cwd (worktree for workers). */
	private builtinTools(cwd: string): AgentTool<any>[] {
		return [
			createBashTool(cwd),
			createReadTool(cwd),
			createWriteTool(cwd),
			createEditTool(cwd),
			createGrepTool(cwd),
			createFindTool(cwd),
			createLsTool(cwd),
			...this.mcpTools,
		];
	}

	/** Team coordination tools for one agent. */
	private teamTools(
		selfName: string,
		bus: MessageBus,
		tasks: TeamTask[],
		isLeader: boolean,
	): AgentTool<any>[] {
		// team_tasks needs a TeamState view; build a lightweight snapshot wrapper
		// that shares the tasks array by reference.
		const stateView: TeamState = {
			name: this.teamDef.name,
			leader: { name: this.teamDef.leader.name, status: "running" },
			workers: new Map(),
			messages: [],
			tasks,
			startedAt: this.state?.startedAt ?? Date.now(),
		};
		return [
			createSendMessageTool(selfName, bus, this.config.maxMessagesPerAgent),
			createBroadcastTool(selfName, bus, this.config.maxMessagesPerAgent),
			createTeamTasksTool(selfName, stateView, isLeader),
		];
	}

	/** Wait for all agents to complete (leader + workers). */
	async waitForCompletion(): Promise<void> {
		await this._completionPromise;
	}

	/** Connect configured MCP servers and expose their tools to every member. */
	private async connectMcpServers(): Promise<void> {
		const configs: McpServerConfig[] = this.config.mcpServers ?? [];
		for (const cfg of configs) {
			try {
				const client = new McpClient(cfg);
				const tools = await client.connect();
				this.mcpClients.push(client);
				for (const t of tools) {
					// MCP tool names are NOT namespaced across servers — different
					// servers can expose the same name (e.g. drawio and
					// chrome-devtools both have "list_pages"). Sending duplicate
					// tool names makes the upstream reject the request with
					// "Tool names must be unique." (400). Prefix like the
					// main-session injection does in extension.ts.
					const prefixed = `mcp_${cfg.name}_${t.name}`;
					const tool = mcpToolToAgentTool(client, t) as unknown as AgentTool<any>;
					this.mcpTools.push({
						...tool,
						name: prefixed,
						label: `MCP: ${cfg.name}/${t.name}`,
					});
				}
				this.emit(
					"message",
					{ from: "mcp", to: "*", content: `MCP server "${cfg.name}" connected (${tools.length} tools)` },
				);
			} catch (e) {
				this.emit(
					"agent_error",
					"mcp",
					`MCP server "${cfg.name}" connect failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
	}

	async stop(): Promise<void> {
		if (!this.state) return;
		// Allow agents to finish naturally before force-stopping.
		await this._completionPromise;
		const all = [this.state.leader, ...this.state.workers.values()];
		await Promise.allSettled(
			all.map(async (h) => {
				if (h.session) await h.session.stop();
				if (h.worktree) {
					const wt = h.worktree as GitWorktree;
					try {
						const state = await wt.contributionState();
						if (state === "clean") {
							await wt.cleanup();
						} else {
							this.emit(
								"agent_error",
								h.name,
								`worktree preserved at ${wt.path} (branch ${wt.branch}, ${state})`,
							);
						}
					} catch {
						// Worktree dir may already be gone — force-clean leftovers.
						await wt.cleanup(true);
					}
				}
				if (h.mailbox?.clearFile) await h.mailbox.clearFile();
			}),
		);
		// Close MCP server connections.
		await Promise.allSettled(this.mcpClients.map((c) => c.close()));
		this.mcpClients = [];
	}

	/** Merge results per worker: { name, branch, hash?, message?, error? }. */
	getResults(): {
		name: string;
		branch: string;
		hash?: string;
		message?: string;
		error?: string;
	}[] {
		return [...this.mergeResults.entries()].map(([name, r]) => ({ name, ...r }));
	}

	/**
	 * Per-member final output summaries (last assistant message, truncated),
	 * plus status. Used by the start_team tool to report what the team did.
	 */
	getMemberSummaries(): {
		name: string;
		isLeader: boolean;
		status: AgentStatus;
		summary: string;
	}[] {
		if (!this.state) return [];
		const handles = [this.state.leader, ...this.state.workers.values()];
		return handles.map((h) => ({
			name: h.name,
			isLeader: h.name === this.state!.leader.name,
			status: h.status,
			summary: h.session?.getFinalSummary?.() ?? "(no summary)",
		}));
	}

	async stopAgent(name: string): Promise<void> {
		const h = this.handleFor(name);
		if (!h?.session) return;
		await h.session.stop();
		h.status = "done";
		if (h.worktree) await h.worktree.cleanup();
	}

	getState(): TeamState | undefined {
		return this.state;
	}
}
