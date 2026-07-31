/**
 * OpenViking memory module unit tests — run with `bun test test/openviking.test.ts`.
 * Uses an in-process mock HTTP server; never touches the real local server.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
	loadOvConfig,
	ovRecall,
	ovCapture,
	ovHealthy,
	ovSessionId,
	type OvConfig,
} from "../src/memory/openviking.js";

/** In-process fake OpenViking server. */
function startMockOv(): Promise<{ server: Server; url: string; captured: Array<{ path: string; body: unknown }> }> {
	const captured: Array<{ path: string; body: unknown }> = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const path = req.url ?? "";
			captured.push({ path, body: body ? JSON.parse(body) : undefined });
			res.setHeader("Content-Type", "application/json");
			if (path === "/health") {
				res.end(JSON.stringify({ status: "ok" }));
			} else if (path === "/api/v1/search/find") {
				const { query } = JSON.parse(body);
				res.end(
					JSON.stringify({
						result: [
							{ uri: "viking://user/doc1", abstract: `记忆片段关于 ${query}` },
							{ uri: "viking://user/doc2", abstract: "另一个相关记忆片段" },
						],
					}),
				);
			} else if (path.startsWith("/api/v1/sessions/") && path.endsWith("/messages")) {
				res.end(JSON.stringify({ result: { id: "m1" } }));
			} else if (path.endsWith("/commit")) {
				res.end(JSON.stringify({ result: { committed: true } }));
			} else {
				res.end(JSON.stringify({ result: {} }));
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve({ server, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, captured });
		});
	});
}

let mock: Awaited<ReturnType<typeof startMockOv>> | undefined;
test("setup", async () => {
	mock = await startMockOv();
});
after(async () => {
	mock?.server.close();
});

function cfg(): OvConfig {
	return { url: mock!.url, apiKey: "test-key", enabled: true };
}

test("loadOvConfig: env vars win", () => {
	const oldUrl = process.env.OPENVIKING_URL;
	const oldKey = process.env.OPENVIKING_API_KEY;
	process.env.OPENVIKING_URL = "http://example.com:1933";
	process.env.OPENVIKING_API_KEY = "env-key";
	try {
		const c = loadOvConfig();
		assert.equal(c.url, "http://example.com:1933");
		assert.equal(c.apiKey, "env-key");
		assert.equal(c.enabled, true);
	} finally {
		if (oldUrl === undefined) delete process.env.OPENVIKING_URL;
		else process.env.OPENVIKING_URL = oldUrl;
		if (oldKey === undefined) delete process.env.OPENVIKING_API_KEY;
		else process.env.OPENVIKING_API_KEY = oldKey;
	}
});

test("loadOvConfig: disabled by env flag", () => {
	const old = process.env.OPENVIKING_MEMORY_ENABLED;
	process.env.OPENVIKING_MEMORY_ENABLED = "0";
	try {
		assert.equal(loadOvConfig().enabled, false);
	} finally {
		if (old === undefined) delete process.env.OPENVIKING_MEMORY_ENABLED;
		else process.env.OPENVIKING_MEMORY_ENABLED = old;
	}
});

test("ovHealthy: reports server status", async () => {
	assert.equal(await ovHealthy(cfg()), true);
});

test("ovRecall: returns formatted memory blocks", async () => {
	const text = await ovRecall(cfg(), "如何优化缓存命中率");
	assert.ok(text.includes("缓存命中率"));
	assert.ok(text.includes("记忆片段"));
	assert.ok(text.startsWith("- "));
});

test("ovRecall: empty for short queries", async () => {
	assert.equal(await ovRecall(cfg(), "hi"), "");
	assert.equal(await ovRecall(cfg(), ""), "");
});

test("ovRecall: empty when server down", async () => {
	const bad: OvConfig = { url: "http://127.0.0.1:1", apiKey: "x", enabled: true };
	assert.equal(await ovRecall(bad, "这是一个足够长的查询词测试服务器不可达"), "");
});

test("ovCapture: posts user+assistant messages and commits", async () => {
	await ovCapture(cfg(), "pi-test-session", "用户问题内容", "助手回复内容");
	const paths = mock!.captured.map((c) => c.path);
	assert.ok(paths.some((p) => p.includes("/messages")));
	assert.ok(paths.some((p) => p.endsWith("/commit")));
	// message bodies carry roles
	const msgBodies = mock!.captured
		.filter((c) => c.path.includes("/messages"))
		.map((c) => c.body as { role: string });
	assert.ok(msgBodies.some((m) => m.role === "user"));
	assert.ok(msgBodies.some((m) => m.role === "assistant"));
});

test("ovSessionId: stable per cwd", () => {
	assert.equal(ovSessionId("/a/b"), ovSessionId("/a/b"));
	assert.notEqual(ovSessionId("/a/b"), ovSessionId("/a/c"));
});
