/**
 * TeamAgentSession: lightweight Agent wrapper.
 *
 * oh-my-pi's AgentSession bundles session persistence, compaction,
 * auto-retry, extension runner, bash history, settings manager — most of
 * which is redundant for team mode (TeamCoordinator owns lifecycle).
 * This wrapper (~150 lines) only wires: Agent + mailbox + team tools.
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type {
	AgentEvent,
	AgentMessage,
	AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { Mailbox } from "./mailbox.js";
import { MessageBus } from "./message-bus.js";
import type { TeamAgentSessionLike, TeamMessage } from "./types.js";

export interface TeamAgentSessionOptions {
	name: string;
	isLeader: boolean;
	role: string;
	task: string;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	/** pi built-in tools (bash/read/write/edit/glob/grep/web) — passed in by coordinator. */
	builtinTools: AgentTool<any>[];
	/** Team-specific tools (send_message/broadcast/team_tasks). */
	teamTools: AgentTool<any>[];
	mailbox: Mailbox;
	messageBus: MessageBus;
	apiKey: string;
	/** Roster of all team member names, for the system prompt. */
	teamMemberNames: string[];
	/** CWD for this agent (worktree path for workers, repo root for leader). */
	cwd: string;
	/** Steering-bridge poll interval in ms. */
	pollIntervalMs?: number;
	/** Max messages this agent may send before being blocked. */
	maxMessagesPerAgent?: number;
}

export class TeamAgentSession implements TeamAgentSessionLike {
	readonly name: string;
	readonly isLeader: boolean;
	private readonly agent: Agent;
	private readonly mailbox: Mailbox;
	private readonly messageBus: MessageBus;
	private readonly pollIntervalMs: number;
	private readonly maxMessagesPerAgent?: number;
	private bridgeTimer: ReturnType<typeof setInterval> | undefined;
	private done = false;

	constructor(opts: TeamAgentSessionOptions) {
		this.name = opts.name;
		this.isLeader = opts.isLeader;
		this.mailbox = opts.mailbox;
		this.messageBus = opts.messageBus;
		this.pollIntervalMs = opts.pollIntervalMs ?? 500;
		this.maxMessagesPerAgent = opts.maxMessagesPerAgent;

		const systemPrompt = this.buildSystemPrompt(opts);
		const allTools = [...opts.builtinTools, ...opts.teamTools];

		// Agent's `streamFn` is typed as required but falls back to pi's default
		// stream function when omitted (agent.ts: `streamFn ?? getDefaultStreamFn()`).
		// We omit it so callers don't need to wire a stream function themselves;
		// the API key flows through getApiKey and pi resolves the provider.
		const agentOptions: Omit<ConstructorParameters<typeof Agent>[0], "streamFn"> = {
			initialState: {
				systemPrompt,
				model: opts.model,
				...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
				tools: allTools,
				messages: [],
			},
			getApiKey: async () => opts.apiKey,
		};
		this.agent = new Agent(agentOptions as ConstructorParameters<typeof Agent>[0]);

		// Auto-notify leader on agent errors (CC v2.1.198+ behavior). pi surfaces
		// the last error on agent.state.errorMessage after agent_end.
		this.agent.subscribe(async (event: AgentEvent) => {
			if (event.type === "agent_end") {
				this.done = true;
				const err = this.agent.state.errorMessage;
				if (err && !this.isLeader) {
					await this.messageBus.send(
						this.name,
						this.findLeaderName(opts.teamMemberNames),
						`[system] turn ended with error: ${err}`,
						this.maxMessagesPerAgent,
					);
				}
			}
		});
	}

	private findLeaderName(names: string[]): string {
		// Leader is conventionally the first registered name and not this worker.
		return names.find((n) => n !== this.name) ?? this.name;
	}

	private buildSystemPrompt(opts: TeamAgentSessionOptions): string {
		const others = opts.teamMemberNames.filter((n) => n !== this.name).join(", ");
		const roleLine = opts.role.trim();
		const leaderHint = this.isLeader
			? [
					"You are the TEAM LEADER. Work in explicit Plan-ReAct phases:",
					"",
					"PHASE 1 — PLAN: Analyze the goal and design the technical approach. Then create the FULL task breakdown on the board in ONE pass using team_tasks add (each task atomic and verifiable; use blocked_by for dependencies). Confirm every task is on the board before moving on.",
					"",
					"PHASE 2 — EXECUTE (ReAct loop): At each turn, first team_tasks list to see the board, then act — assign tasks to workers (team_tasks assign or send_message), handle their feedback, arbitrate conflicts, and revise the plan (add/complete tasks) when reality differs from the plan. Track progress on the board.",
					"",
					"PHASE 3 — SYNTHESIZE: When all tasks are done, combine each worker's output into a final summary report.",
					"Do not write implementation code yourself — delegate to workers.",
				].join("\n")
			: "You are a WORKER. Claim tasks via team_tasks, do the work, mark them complete, and report to the leader via send_message. You may message any teammate directly — you do not need to route through the leader.";
		const lines = [
			roleLine,
			"",
			leaderHint,
			"",
			`Your name: ${opts.name}`,
			`Other team members: ${others}`,
			`Working directory: ${opts.cwd}`,
			"",
			"Communication: use send_message to message any teammate by name, or broadcast to all. Messages you receive arrive as `[team] <name> says: <content>`.",
			"Tasks: use team_tasks to list/add/assign/complete. add is leader-only.",
			"",
			"Initial task:\n" + opts.task,
		];
		if (!this.isLeader) {
			lines.push(
				"",
				"Completion protocol (MANDATORY when you changed files):",
				"- Commit your work before you stop: git add <only files you changed> (NEVER git add . or git add -A)",
				"- Use a clear, descriptive commit message",
				"- Report the commit hash and a one-line summary of what you did in your final message to the leader",
				"- Do not fix unrelated issues; if you find any, mention them as follow-ups instead",
				"- If the task is impossible, stop and explain why to the leader",
			);
		}
		return lines.join("\n");
	}

	async start(): Promise<void> {
		// Mailbox → steering bridge: drain mailbox into agent.steer() periodically.
		this.bridgeTimer = setInterval(() => {
			if (this.done) return;
			const msgs = this.mailbox.drain();
			for (const msg of msgs) {
				const agentMessage: AgentMessage = {
					role: "user",
					content: [{ type: "text", text: `[team] ${msg.from} says: ${msg.content}` }],
				} as AgentMessage;
				this.agent.steer(agentMessage);
			}
		}, this.pollIntervalMs);

		// Kick off the initial prompt; the ReAct loop runs to completion.
		// If the agent finishes, queued steering/follow-up messages will wake it
		// via agent.continue() — the mailbox bridge calls steer(), and a subsequent
		// prompt/continue drains it.
		await this.agent.prompt(this.buildInitialPrompt());
	}

	private buildInitialPrompt(): string {
		// The system prompt already carries the task; the first user message
		// is a short kick-off so the model begins acting.
		return this.isLeader
			? "Begin. Decompose the goal into tasks and dispatch them."
			: "Begin. List tasks and claim one to work on.";
	}

	async stop(): Promise<void> {
		if (this.bridgeTimer) {
			clearInterval(this.bridgeTimer);
			this.bridgeTimer = undefined;
		}
		this.agent.abort();
		this.done = true;
	}

	/** True once the agent's ReAct loop has emitted agent_end. */
	isDone(): boolean {
		return this.done;
	}

	/**
	 * Final output summary: the last assistant text message (truncated),
	 * falling back to the run error, then "(no output)".
	 */
	getFinalSummary(): string {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role !== "assistant") continue;
			const text = (msg.content ?? [])
				.map((c) => (c.type === "text" ? c.text : ""))
				.join(" ")
				.trim();
			if (text.length > 0) return text.length > 500 ? `${text.slice(0, 500)}…` : text;
		}
		return this.agent.state.errorMessage ?? "(no output)";
	}
}
