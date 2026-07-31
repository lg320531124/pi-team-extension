/**
 * Default team template for natural-language team startup.
 *
 * `buildDefaultTeamDef` turns a user goal into a TeamDefinition with a
 * leader (architect) that autonomously decomposes the goal into tasks and
 * coordinates workers. Supports a small built-in worker role catalog
 * (coder / reviewer / tester / writer).
 */
import type { TeamDefinition, TeamWorkerDef } from "./types.js";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export interface DefaultTeamOptions {
	/** The user's goal the team should accomplish. */
	goal: string;
	/**
	 * Worker roles to spawn. Default ["coder", "reviewer"].
	 * Supported names: coder, reviewer, tester, writer.
	 * Unknown names are skipped.
	 */
	workers?: string[];
	/** Optional model override for all members. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface BuiltinWorker {
	role: string;
	task: string;
}

const BUILTIN_WORKERS: Record<string, BuiltinWorker> = {
	coder: {
		role: "你是资深开发工程师。认领任务、实现代码、自测通过后标记完成，并向 leader 报告实现要点。代码改动必须 commit（只 add 你改的文件，禁止 git add .），报告 commit hash。",
		task: "等待 leader 通过 team_tasks 分配任务。用 team_tasks list 查看任务板并认领可做任务。",
	},
	reviewer: {
		role: "你是资深代码审查员。审查 coder 的实现，找出 bug、风格问题和架构隐患。发现的问题通过 send_message 反馈给 coder（抄送 leader）。审查结论用 send_message 发给相关成员。",
		task: "等待 coder 通过 send_message 发送代码审查请求。审查完成后通过 team_tasks complete 标记审查任务。",
	},
	tester: {
		role: "你是测试工程师。为 coder 的实现编写并运行测试（单元/集成），覆盖关键路径和边界情况。测试失败立即通过 send_message 反馈给 coder。全部通过后向 leader 报告测试结果。",
		task: "等待 coder 的实现完成后进行测试。用 team_tasks list 查看是否有测试任务可认领。",
	},
	writer: {
		role: "你是技术文档工程师。为团队产出编写/更新文档（README、设计文档、使用指南）。文档要清晰、准确、面向读者。完成后通过 send_message 向 leader 报告文档位置和要点。",
		task: "等待团队成员完成后编写文档。用 team_tasks list 查看是否有文档任务可认领。",
	},
};

/** Default leader prompt: architect that autonomously plans and dispatches. */
function leaderRole(goal: string): string {
	return [
		`你是系统架构师和 TEAM LEADER。用户目标：${goal}`,
		"你的职责：",
		"- 自主分析目标，设计技术方案",
		"- 用 team_tasks add 把目标分解为具体任务（可设置 blocked_by 依赖）",
		"- 用 team_tasks assign 或 send_message 把任务分配给合适的 worker",
		"- 协调 worker 之间的沟通，仲裁冲突",
		"- 当所有任务完成时，综合各 worker 的产出，用 send_message 向用户风格的总结报告最终结果",
		"注意：任务必须通过 team_tasks 追踪；重要沟通用 send_message；不要自己写实现代码，把实现交给 worker。",
	].join("\n");
}

/** Build a TeamDefinition from a natural-language goal. */
export function buildDefaultTeamDef(opts: DefaultTeamOptions): TeamDefinition {
	const workerNames = (opts.workers ?? ["coder", "reviewer"]).filter(
		(name) => name in BUILTIN_WORKERS,
	);

	const workers: Record<string, TeamWorkerDef> = {};
	for (const name of workerNames) {
		const def = BUILTIN_WORKERS[name];
		workers[name] = {
			role: def.role,
			task: def.task,
			...(opts.model ? { model: opts.model } : {}),
			...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
		};
	}

	return {
		name: "auto-team",
		description: `Auto team for goal: ${opts.goal}`,
		leader: {
			name: "architect",
			role: leaderRole(opts.goal),
			...(opts.model ? { model: opts.model } : {}),
			...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
		},
		workers,
	};
}

export const BUILTIN_WORKER_NAMES = Object.keys(BUILTIN_WORKERS);
