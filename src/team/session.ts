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

/**
 * Transient provider/network failures that are safe to retry. The bare Agent
 * used in team mode skips pi's session-level auto-retry, so a single dropped
 * stream (e.g. "Stream ended without finish_reason") would otherwise kill the
 * worker's whole run — and with it the team run. Intentional stops
 * ("Request was aborted") deliberately never match.
 */
const TRANSIENT_ERROR_RE =
	/Stream ended without finish_reason|fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|UND_ERR|network error|\b429\b|\b5\d\d\b|rate limit/i;

function isTransientError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return TRANSIENT_ERROR_RE.test(msg) && !/aborted/i.test(msg);
}

/** Base delay for the first retry; doubles per attempt. */
const RETRY_DELAY_BASE_MS = 1_000;
/** Retries after the initial attempt (3 tries total). */
const MAX_RETRIES = 2;

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
	private readonly teamMemberNames: string[];
	private bridgeTimer: ReturnType<typeof setInterval> | undefined;
	private done = false;
	/** Error captured at agent_end; reported to the leader only when retries are exhausted. */
	private pendingError: string | undefined;

	constructor(opts: TeamAgentSessionOptions) {
		this.name = opts.name;
		this.isLeader = opts.isLeader;
		this.mailbox = opts.mailbox;
		this.messageBus = opts.messageBus;
		this.pollIntervalMs = opts.pollIntervalMs ?? 500;
		this.maxMessagesPerAgent = opts.maxMessagesPerAgent;
		this.teamMemberNames = opts.teamMemberNames;

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
		// the last error on agent.state.errorMessage after agent_end. The
		// notification is deferred to runWithTransientRetry so a recovered
		// transient failure is never reported as fatal.
		this.agent.subscribe(async (event: AgentEvent) => {
			if (event.type === "agent_end") {
				this.done = true;
				const err = this.agent.state.errorMessage;
				if (err && !this.isLeader) {
					this.pendingError = err;
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
		// prompt/continue drains it. Transient provider failures are retried.
		await this.runWithTransientRetry(() => this.agent.prompt(this.buildInitialPrompt()));
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

	/**
	 * Re-activate a finished agent so it processes queued steering/mailbox
	 * messages. Used by the coordinator's completion check: when every member's
	 * ReAct loop has ended but the task board still has unfinished tasks, the
	 * leader (and any worker with queued assignments) is nudged back into its
	 * loop instead of declaring a hollow "team done".
	 *
	 * The bridge timer from start() is still running; with done=false it resumes
	 * draining the mailbox into steer(). continue() then runs the loop and
	 * consumes the queued steering messages (including nudge).
	 */
	async wake(nudge?: string): Promise<void> {
		if (!this.done) return; // loop still running — nothing to wake
		if (nudge) {
			this.agent.steer({
				role: "user",
				content: [{ type: "text", text: nudge }],
				timestamp: Date.now(),
			});
		}
		this.done = false;
		try {
			await this.runWithTransientRetry(() => this.agent.continue());
		} catch (err) {
			// The loop has actually ended — a failed wake must not leave the
			// session looking alive to the coordinator's completion check.
			this.done = true;
			throw err;
		}
	}

	/**
	 * Run a prompt/continue attempt with bounded retries for transient
	 * provider/network failures (e.g. "Stream ended without finish_reason").
	 * The bare Agent used here omits pi's session-level auto-retry, so without
	 * this a single dropped stream killed the worker — and with it the team run.
	 */
	private async runWithTransientRetry(run: () => Promise<void>): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			try {
				await run();
				this.pendingError = undefined; // transient failure recovered — nothing to report
				return;
			} catch (err) {
				if (!isTransientError(err) || attempt >= MAX_RETRIES) {
					await this.notifyLeaderOnFailure();
					throw err;
				}
				// The agent appended an empty assistant error placeholder; drop it
				// so the retry replays from the pre-failure transcript.
				this.discardFailedTurnMessage();
				const delayMs = RETRY_DELAY_BASE_MS * 2 ** attempt;
				console.warn(
					`[team] ${this.name}: transient error (${err instanceof Error ? err.message : String(err)}); retrying in ${delayMs}ms (attempt ${attempt + 2}/${MAX_RETRIES + 1})`,
				);
				await new Promise((r) => setTimeout(r, delayMs));
			}
		}
	}

	/** Report the terminal run error to the leader once the retry budget is spent. */
	private async notifyLeaderOnFailure(): Promise<void> {
		if (this.isLeader || !this.pendingError) return;
		await this.messageBus.send(
			this.name,
			this.findLeaderName(this.teamMemberNames),
			`[system] turn ended with error: ${this.pendingError}`,
			this.maxMessagesPerAgent,
		);
		this.pendingError = undefined;
	}

	/** Remove the empty assistant error placeholder the agent appended on failure. */
	private discardFailedTurnMessage(): void {
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		if (!last || last.role !== "assistant" || last.stopReason !== "error") return;
		const hasText = (last.content ?? []).some(
			(c) => c.type === "text" && c.text.length > 0,
		);
		if (!hasText) messages.pop();
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
