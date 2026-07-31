/**
 * pi-team-extension — Agent Team coordination for @earendil-works/pi.
 *
 * Peer-to-peer multi-agent: named leader + workers, mailbox messaging
 * via agent.steer(), shared task board with dependencies, git worktree
 * isolation per worker. Depends only on pi, not oh-my-pi.
 */
export { TeamCoordinator } from "./team/coordinator.js";
export type { CoordinatorEvents } from "./team/coordinator.js";
export { TeamAgentSession } from "./team/session.js";
export type { TeamAgentSessionOptions } from "./team/session.js";
export { GitWorktree } from "./team/worktree.js";
export type { GitWorktreeOptions, ContributionState } from "./team/worktree.js";
export { MessageBus } from "./team/message-bus.js";
export type { MessageBusEvents } from "./team/message-bus.js";
export { Mailbox } from "./team/mailbox.js";
export type { MailboxOptions } from "./team/mailbox.js";
export { parseTeamYaml, TeamSchemaError } from "./team/schema.js";
export { buildDefaultTeamDef, BUILTIN_WORKER_NAMES } from "./team/default-team.js";
export type { DefaultTeamOptions } from "./team/default-team.js";
export { createSendMessageTool } from "./team/tools/send-message.js";
export { createBroadcastTool } from "./team/tools/broadcast.js";
export { createTeamTasksTool } from "./team/tools/team-tasks.js";
export { default as teamExtension } from "./extension.js";
export type {
	AgentHandle,
	AgentStatus,
	MailboxLike,
	TeamAgentSessionLike,
	TeamConfig,
	TeamDefinition,
	TeamLeaderDef,
	TeamMessage,
	TeamState,
	TeamTask,
	TeamWorkerDef,
	WorktreeLike,
} from "./team/types.js";
