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
import { EventEmitter } from "node:events";
import { Mailbox } from "./mailbox.js";
import { MessageBus } from "./message-bus.js";
import { TeamAgentSession } from "./session.js";
import { createBroadcastTool } from "./tools/broadcast.js";
import { createSendMessageTool } from "./tools/send-message.js";
import { createTeamTasksTool } from "./tools/team-tasks.js";
import type {
	AgentHandle,
	TeamConfig,
	TeamDefinition,
	TeamState,
	TeamTask,
} from "./types.js";
import { GitWorktree } from "./worktree.js";

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
		};
		this.modelResolver = modelResolver;
	}

	async start(): Promise<TeamState> {
		const bus = new MessageBus();
		const tasks: TeamTask[] = [];
		const startedAt = Date.now();

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
					const wt = await GitWorktree.create({
						repoRoot: this.config.repoRoot,
						name: wName,
					});
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
		// that agent's ReAct loop completes (or errors).
		const all = [this.runAgent(this.teamDef.leader.name, leaderSession), ...workerRuns];
		void Promise.allSettled(all).then(() => this.emit("team_done"));

		return this.state;
	}

	private async runAgent(name: string, session: TeamAgentSession): Promise<void> {
		try {
			await session.start();
			const handle = this.handleFor(name);
			if (handle) handle.status = "done";
			this.emit("agent_done", name);
		} catch (e) {
			const handle = this.handleFor(name);
			if (handle) handle.status = "error";
			const msg = e instanceof Error ? e.message : String(e);
			this.emit("agent_error", name, msg);
		}
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

	async stop(): Promise<void> {
		if (!this.state) return;
		const all = [this.state.leader, ...this.state.workers.values()];
		await Promise.allSettled(
			all.map(async (h) => {
				if (h.session) await h.session.stop();
				if (h.worktree) await h.worktree.cleanup();
				if (h.mailbox?.clearFile) await h.mailbox.clearFile();
			}),
		);
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
