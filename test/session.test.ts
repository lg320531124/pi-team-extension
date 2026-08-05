/**
 * TeamAgentSession transient-failure retry tests.
 *
 * Regression coverage for two production incidents:
 *  1. "Stream ended without finish_reason" killed a worker's whole run
 *     (no auto-retry in team mode) → runWithTransientRetry.
 *  2. A stream that neither errors nor finishes hung `agent.continue()`
 *     forever, so start_team never returned ("No result provided") →
 *     runWithHeartbeat stall detection.
 */
import { describe, expect, test } from "bun:test";
import { setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import { TeamAgentSession, type TeamAgentSessionOptions } from "../src/team/session.js";

// The stub stream function is only a constructor placeholder — none of these
// tests ever drive a real model stream (runs are injected directly).
setDefaultStreamFn((() => ({})) as never);

/** Minimal model stub — TeamAgentSession never streams during these tests. */
const stubModel = {
	provider: "test",
	id: "test-model",
	api: "openai-completions",
} as never;

function makeSession(
	overrides: Partial<TeamAgentSessionOptions> = {},
): TeamAgentSession {
	const opts: TeamAgentSessionOptions = {
		name: "worker",
		isLeader: false,
		role: "test worker",
		task: "test task",
		model: stubModel,
		builtinTools: [],
		teamTools: [],
		mailbox: {
			drain: () => [],
		} as never,
		messageBus: {
			send: async () => {},
		} as never,
		apiKey: "test-key",
		teamMemberNames: ["leader", "worker"],
		cwd: "/tmp",
		pollIntervalMs: 60_000, // keep the steering bridge inert
		streamHeartbeatMs: 100,
		heartbeatCheckMs: 10,
		...overrides,
	};
	return new TeamAgentSession(opts);
}

/** Access the private retry machinery for black-box tests. */
function retryable(
	session: TeamAgentSession,
): (run: () => Promise<void>) => Promise<void> {
	return (session as unknown as {
		runWithTransientRetry: (run: () => Promise<void>) => Promise<void>;
	}).runWithTransientRetry.bind(session);
}

/**
 * Spy on the agent's abort() so tests can observe heartbeat-triggered aborts
 * (the real Agent only surfaces aborts while a run is active, and these tests
 * never start a real prompt).
 */
function spyAbort(session: TeamAgentSession): { state: { aborted: boolean } } {
	const agent = (session as unknown as { agent: { abort: () => void } }).agent;
	const state = { aborted: false };
	const orig = agent.abort.bind(agent);
	agent.abort = () => {
		state.aborted = true;
		orig();
	};
	return { state };
}

/**
 * A run that hangs forever, rejecting like a real prompt does when the
 * heartbeat aborts it. The aborted flag is reset per attempt so only the
 * current attempt's abort counts.
 */
function hungRun(state: { aborted: boolean }): () => Promise<void> {
	return () =>
		new Promise<void>((_resolve, reject) => {
			state.aborted = false; // per-attempt reset
			const poll = setInterval(() => {
				if (state.aborted) {
					clearInterval(poll);
					reject(new Error("Request was aborted"));
				}
			}, 5);
		});
}

describe("TeamAgentSession retry machinery", () => {
	test("retries a hung stream (no events) and succeeds on the next attempt", async () => {
		const session = makeSession();
		const { state } = spyAbort(session);
		let attempts = 0;

		await retryable(session)(async () => {
			attempts++;
			if (attempts === 1) {
				// First attempt: stream stalls — no events, never finishes.
				await hungRun(state)();
			}
			// Second attempt succeeds immediately.
		});

		expect(attempts).toBe(2);
		expect(state.aborted).toBe(true); // the hung stream was aborted
	});

	test("recovers without reporting the stall to the leader", async () => {
		const sent: string[] = [];
		const sessionWithBus = makeSession({
			messageBus: {
				send: async (from: string, to: string, content: string) => {
					sent.push(`${from}→${to}: ${content}`);
				},
			} as never,
		});
		const { state } = spyAbort(sessionWithBus);
		let attempts = 0;

		await retryable(sessionWithBus)(async () => {
			attempts++;
			if (attempts === 1) await hungRun(state)();
		});

		expect(attempts).toBe(2);
		expect(sent).toEqual([]); // recovered stall must not alarm the leader
	});

	test("does not retry a non-transient error", async () => {
		const session = makeSession();
		let attempts = 0;

		await expect(
			retryable(session)(async () => {
				attempts++;
				throw new Error("tool execution failed: boom");
			}),
		).rejects.toThrow("boom");

		expect(attempts).toBe(1);
	});

	test("does not retry an intentional abort", async () => {
		const session = makeSession();
		let attempts = 0;

		await expect(
			retryable(session)(async () => {
				attempts++;
				throw new Error("Request was aborted");
			}),
		).rejects.toThrow("Request was aborted");

		expect(attempts).toBe(1);
	});

	test("retries a dropped stream and succeeds", async () => {
		const session = makeSession();
		let attempts = 0;

		await retryable(session)(async () => {
			attempts++;
			if (attempts === 1) {
				throw new Error("Stream ended without finish_reason");
			}
		});

		expect(attempts).toBe(2);
	});

	test("gives up after the retry budget is exhausted", async () => {
		const session = makeSession();
		const { state } = spyAbort(session);
		let attempts = 0;

		await expect(
			retryable(session)(async () => {
				attempts++;
				if (attempts <= 3) await hungRun(state)();
			}),
		).rejects.toThrow(/stalled/);

		expect(attempts).toBe(3); // 1 initial + 2 retries
	});
});
