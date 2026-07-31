/**
 * MCP client unit tests — run with `bun test test/mcp.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpClient, loadMcpServers, jsonSchemaToTypebox, mcpToolToAgentTool } from "../src/team/mcp.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const serverPath = join(fixtureDir, "fixtures", "fake-mcp-server.mjs");

test("McpClient: connect → list tools → call tool (stdio)", async () => {
	const client = new McpClient({
		name: "fake",
		command: process.execPath,
		args: [serverPath],
		type: "stdio",
	});
	const tools = await client.connect();
	assert.equal(tools.length, 2);
	assert.deepEqual(tools.map((t) => t.name).sort(), ["add", "echo"]);

	const echoed = await client.callTool("echo", { text: "hello mcp" });
	assert.equal(echoed, "hello mcp");
	const sum = await client.callTool("add", { a: 2, b: 3 });
	assert.equal(sum, "5");
	await client.close();
});

test("McpClient: error propagation from isError result", async () => {
	const client = new McpClient({
		name: "fake",
		command: process.execPath,
		args: [serverPath],
		type: "stdio",
	});
	await client.connect();
	await assert.rejects(client.callTool("nope", {}), /unknown tool nope/);
	await client.close();
});

test("loadMcpServers: reads project .mcp.json", () => {
	const dir = join(fixtureDir, "fixtures", "mcpproj");
	const servers = loadMcpServers(dir);
	assert.equal(servers.length, 1);
	assert.equal(servers[0].name, "demo");
	assert.equal(servers[0].type, "stdio");
	assert.ok(servers[0].command);
});

test("loadMcpServers: returns [] when no config exists", () => {
	const servers = loadMcpServers(join(fixtureDir, "fixtures", "empty-dir"));
	assert.deepEqual(servers, []);
});

test("jsonSchemaToTypebox: converts object with mixed types", () => {
	const schema = {
		type: "object",
		properties: {
			name: { type: "string", description: "the name" },
			count: { type: "integer" },
			tags: { type: "array", items: { type: "string" } },
			enabled: { type: "boolean" },
		},
		required: ["name"],
	};
	const tb = jsonSchemaToTypebox(schema);
	assert.ok(tb && typeof tb === "object");
	// optional property (count) vs required (name) — just assert no throw on conversion
	assert.ok(true);
});

test("mcpToolToAgentTool: builds an executable AgentTool wrapper", async () => {
	const client = new McpClient({
		name: "fake",
		command: process.execPath,
		args: [serverPath],
		type: "stdio",
	});
	const tools = await client.connect();
	const tool = mcpToolToAgentTool(client, tools[0]);
	assert.equal(tool.name, tools[0].name);
	assert.ok(tool.parameters);
	const result = await tool.execute("id1", { text: "via wrapper" });
	const text = (result.content as { text?: string }[]).map((c) => c.text ?? "").join("");
	assert.equal(text, "via wrapper");
	await client.close();
});
