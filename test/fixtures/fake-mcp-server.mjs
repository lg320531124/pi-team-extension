// Fake MCP stdio server for tests — responds to initialize / tools/list / tools/call.
process.stdin.setEncoding("utf8");
let buf = "";

const tools = [
	{
		name: "echo",
		description: "Echo the input text",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
	},
	{
		name: "add",
		description: "Add two numbers",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
];

function respond(id, result) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

process.stdin.on("data", (chunk) => {
	buf += chunk;
	const lines = buf.split("\n");
	buf = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		if (msg.method === "initialize") {
			respond(msg.id, {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "fake-mcp", version: "1.0.0" },
			});
		} else if (msg.method === "notifications/initialized") {
			// no-op
		} else if (msg.method === "tools/list") {
			respond(msg.id, { tools });
		} else if (msg.method === "tools/call") {
			const { name, arguments: args } = msg.params ?? {};
			if (name === "echo") {
				respond(msg.id, { content: [{ type: "text", text: String(args?.text ?? "") }] });
			} else if (name === "add") {
				const sum = Number(args?.a ?? 0) + Number(args?.b ?? 0);
				respond(msg.id, { content: [{ type: "text", text: String(sum) }] });
			} else {
				respond(msg.id, {
					content: [{ type: "text", text: `unknown tool ${name}` }],
					isError: true,
				});
			}
		}
	}
});
