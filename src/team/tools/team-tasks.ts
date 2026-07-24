/**
 * team_tasks tool: shared task board.
 *
 * Leader can add/assign/complete; workers can list/assign(unblocked)/complete
 * their own tasks. Tasks carry `blockedBy` dependencies — an assign is
 * rejected until all blockers are done. This mirrors CC agent-teams'
 * shared task list with dependency resolution.
 *
 * Concurrency: JS is single-threaded, so v1 uses synchronous mutation
 * of the in-memory TeamState. The file-lock complexity CC needs (multiple
 * Claude processes across tmux panes) doesn't apply in-process.
 * ponytail: global mutation, no lock; fine while single-process.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { TextContent } from "@earendil-works/pi-ai";
import type { TeamState, TeamTask } from "../types.js";

const tasksSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("add"),
			Type.Literal("assign"),
			Type.Literal("complete"),
		],
		{ description: "list: show all. add: create (leader only). assign: claim. complete: mark done." },
	),
	task_id: Type.Optional(Type.String({ description: "Task ID (required for assign/complete)" })),
	title: Type.Optional(Type.String({ description: "Task title (required for add)" })),
	assign_to: Type.Optional(Type.String({ description: "Assign task to a teammate (assign)" })),
	blocked_by: Type.Optional(
		Type.Array(Type.String(), { description: "Task IDs this task depends on (add)" }),
	),
});

type TasksInput = Static<typeof tasksSchema>;

export function createTeamTasksTool(
	selfName: string,
	state: TeamState,
	isLeader: boolean,
): AgentTool<typeof tasksSchema> {
	return {
		name: "team_tasks",
		label: "Team Tasks",
		description:
			"View or update the shared team task board. list: show all tasks. add: create a task (leader only). assign: claim an unblocked task. complete: mark your task done.",
		parameters: tasksSchema,
		async execute(_toolCallId, params: TasksInput): Promise<AgentToolResult<unknown>> {
			switch (params.action) {
				case "list":
					return okResult(formatTaskList(state.tasks));
				case "add":
					if (!isLeader) {
						return errorResult("Only the leader can add tasks.");
					}
					return addTask(state, params, selfName);
				case "assign":
					return assignTask(state, params, selfName);
				case "complete":
					return completeTask(state, params, selfName);
				default:
					return errorResult(`Unknown action: ${params.action as string}`);
			}
		},
	};
}

let taskCounter = 0;
function nextId(): string {
	taskCounter += 1;
	return `t${taskCounter}`;
}

function addTask(state: TeamState, params: TasksInput, createdBy: string): AgentToolResult<unknown> {
	const title = params.title?.trim();
	if (!title) {
		return errorResult("`title` is required for add.");
	}
	const task: TeamTask = {
		id: nextId(),
		title,
		status: "pending",
		createdBy,
		blockedBy: params.blocked_by ?? [],
	};
	state.tasks.push(task);
	return okResult(`Task ${task.id} created.\n${formatTaskList(state.tasks)}`);
}

function assignTask(state: TeamState, params: TasksInput, selfName: string): AgentToolResult<unknown> {
	const id = params.task_id?.trim();
	if (!id) {
		return errorResult("`task_id` is required for assign.");
	}
	const task = state.tasks.find((t) => t.id === id);
	if (!task) {
		return errorResult(`No task with id "${id}".`);
	}
	if (task.status === "done") {
		return errorResult(`Task ${id} is already done.`);
	}
	if (task.assignedTo && task.assignedTo !== selfName) {
		return errorResult(`Task ${id} is already assigned to ${task.assignedTo}.`);
	}
	// Dependency check: all blockers must be done.
	const blockers = task.blockedBy.map((bid) => state.tasks.find((t) => t.id === bid)).filter(Boolean) as TeamTask[];
	const pending = blockers.filter((b) => b.status !== "done");
	if (pending.length > 0) {
		return errorResult(
			`Task ${id} is blocked by: ${pending.map((b) => `${b.id} (${b.title})`).join(", ")}. Wait for them to complete.`,
		);
	}
	task.assignedTo = selfName;
	task.status = "in_progress";
	return okResult(`Task ${id} assigned to you.\n${formatTaskList(state.tasks)}`);
}

function completeTask(state: TeamState, params: TasksInput, selfName: string): AgentToolResult<unknown> {
	const id = params.task_id?.trim();
	if (!id) {
		return errorResult("`task_id` is required for complete.");
	}
	const task = state.tasks.find((t) => t.id === id);
	if (!task) {
		return errorResult(`No task with id "${id}".`);
	}
	if (task.assignedTo && task.assignedTo !== selfName) {
		return errorResult(`Task ${id} is assigned to ${task.assignedTo}, not you.`);
	}
	task.status = "done";
	// Auto-unblock is implicit: assign checks blocker status at assign time.
	return okResult(`Task ${id} marked done.\n${formatTaskList(state.tasks)}`);
}

function formatTaskList(tasks: TeamTask[]): string {
	if (tasks.length === 0) {
		return "No tasks on the board.";
	}
	return tasks
		.map((t) => {
			const blockers =
				t.blockedBy.length > 0 ? ` [blocked by ${t.blockedBy.join(", ")}]` : "";
			const assignee = t.assignedTo ? ` @${t.assignedTo}` : "";
			return `- ${t.id} [${t.status}]${assignee}${blockers}: ${t.title}`;
		})
		.join("\n");
}

function okResult(text: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text } as TextContent],
		details: { ok: true },
	};
}

function errorResult(text: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text } as TextContent],
		details: { ok: false, error: text },
	};
}
