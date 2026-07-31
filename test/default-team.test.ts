/**
 * Default team template unit tests — run with `bun test test/default-team.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDefaultTeamDef, BUILTIN_WORKER_NAMES } from "../src/team/default-team.js";

test("buildDefaultTeamDef: default worker set is coder + reviewer", () => {
	const def = buildDefaultTeamDef({ goal: "实现登录功能" });
	assert.equal(def.name, "auto-team");
	assert.equal(def.leader.name, "architect");
	assert.deepEqual(Object.keys(def.workers).sort(), ["coder", "reviewer"]);
});

test("buildDefaultTeamDef: goal is embedded in the leader role", () => {
	const def = buildDefaultTeamDef({ goal: "重构缓存层" });
	assert.match(def.leader.role, /重构缓存层/);
	// Leader role must instruct autonomous decomposition.
	assert.match(def.leader.role, /team_tasks add/);
});

test("buildDefaultTeamDef: custom worker list filters unknown roles", () => {
	const def = buildDefaultTeamDef({ goal: "写文档", workers: ["writer", "nonexistent", "coder"] });
	assert.deepEqual(Object.keys(def.workers).sort(), ["coder", "writer"]);
});

test("buildDefaultTeamDef: unknown-only workers produce empty team", () => {
	const def = buildDefaultTeamDef({ goal: "x", workers: ["bogus"] });
	assert.equal(Object.keys(def.workers).length, 0);
});

test("buildDefaultTeamDef: model and thinkingLevel propagate to all members", () => {
	const def = buildDefaultTeamDef({
		goal: "x",
		workers: ["coder"],
		model: "deepseek-v4-flash",
		thinkingLevel: "high",
	});
	assert.equal(def.leader.model, "deepseek-v4-flash");
	assert.equal(def.leader.thinkingLevel, "high");
	assert.equal(def.workers.coder.model, "deepseek-v4-flash");
	assert.equal(def.workers.coder.thinkingLevel, "high");
});

test("BUILTIN_WORKER_NAMES exposes the role catalog", () => {
	assert.deepEqual(BUILTIN_WORKER_NAMES.sort(), ["coder", "reviewer", "tester", "writer"]);
});
