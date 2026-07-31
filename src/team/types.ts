/**
 * pi-team-extension — core type definitions.
 *
 * Depends only on @earendil-works/pi-agent-core and @earendil-works/pi-ai.
 * No oh-my-pi dependency.
 *
 * NOTE: pi's tool type is `AgentTool` (extends `Tool`), not `ToolDefinition`.
 * The spec draft used `ToolDefinition`; this implementation uses the real
 * pi type `AgentTool` from @earendil-works/pi-agent-core.
 */
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentTool, AgentMessage } from "@earendil-works/pi-agent-core";

/** YAML team definition root. */
export interface TeamDefinition {
	name: string;
	description?: string;
	leader: TeamLeaderDef;
	workers: Record<string, TeamWorkerDef>;
}

export interface TeamLeaderDef {
	name: string;
	/** System prompt describing the leader's role + coordination duties. */
	role: string;
	/** Initial task. Defaults to "decompose the goal and dispatch tasks" if omitted. */
	task?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface TeamWorkerDef {
	/** System prompt describing the worker's role + communication style. */
	role: string;
	/** Initial task to start working on. */
	task: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Whether to isolate this worker in its own git worktree. Default: true. */
	worktree?: boolean;
}
/** A peer-to-peer message between team members. */
export interface TeamMessage {
	id: string;
	/** Sender agent name (leader or worker). */
	from: string;
	/** Recipient agent name, or "*" for broadcast. */
	to: string;
	content: string;
	timestamp: number;
}

/** A task on the shared team board. */
export interface TeamTask {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "done";
	assignedTo?: string;
	createdBy: string;
	/** IDs of tasks that must be done before this one can be assigned. */
	blockedBy: string[];
}

/** Snapshot of team state. */
export interface TeamState {
	name: string;
	leader: AgentHandle;
	workers: Map<string, AgentHandle>;
	messages: TeamMessage[];
	tasks: TeamTask[];
	startedAt: number;
}

/** Whether a worker's worktree holds commits / uncommitted changes / nothing. */
export type ContributionState = "contributed" | "modified" | "clean";

/** Runtime handle for a team member (leader or worker). */
export interface AgentHandle {
	name: string;
	/** Session wrapper — set by TeamCoordinator after spawn. */
	session?: TeamAgentSessionLike;
	mailbox?: MailboxLike;
	worktree?: WorktreeLike;
	status: AgentStatus;
}

export type AgentStatus = "pending" | "running" | "idle" | "error" | "done";

/**
 * Structural type for the session wrapper. The concrete `TeamAgentSession`
 * class in session.ts satisfies this; declared here to avoid a circular
 * import between types.ts and session.ts.
 */
export interface TeamAgentSessionLike {
	readonly name: string;
	readonly isLeader: boolean;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Final output summary (last assistant message, truncated). */
	getFinalSummary?(): string;
}

export interface MailboxLike {
	push(msg: TeamMessage): Promise<boolean> | Promise<void> | void | boolean;
	drain(): TeamMessage[];
	on(event: "message", handler: () => void): void;
	clearFile?(): Promise<void>;
}

export interface WorktreeLike {
	readonly path: string;
	readonly branch: string;
	/** v2: contribution classification vs the worktree's creation baseline. */
	contributionState?(): Promise<ContributionState>;
	/** v2: latest commit relative to the baseline, if any. */
	lastCommit?(): Promise<{ hash: string; message: string } | null>;
	/** v2: force=true overrides the "preserve dirty/committed" safety. */
	cleanup(force?: boolean): Promise<void>;
}

/** Configuration passed to TeamCoordinator. */
export interface TeamConfig {
	/** API key for the LLM provider. */
	apiKey: string;
	/** Default model id if a member omits `model`. */
	defaultModel: string;
	/** Working directory (repo root for worktrees). */
	cwd: string;
	/** Optional repo root override; defaults to cwd. */
	repoRoot?: string;
	/** Max messages one agent may receive before mailbox rejects. Default 10. */
	mailboxCapacity?: number;
	/** Max messages one agent may send in a session. Default 200. */
	maxMessagesPerAgent?: number;
	/** Steering-bridge poll interval in ms. Default 500. */
	pollIntervalMs?: number;
}

/** Re-exported pi types for convenience. */
export type { Model, ThinkingLevel, AgentTool, AgentMessage };
