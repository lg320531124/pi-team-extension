/**
 * broadcast tool: send a message to every teammate at once.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { TextContent } from "@earendil-works/pi-ai";
import type { MessageBus } from "../message-bus.js";

const broadcastSchema = Type.Object({
	content: Type.String({ description: "The message to broadcast to all team members." }),
});

type BroadcastInput = Static<typeof broadcastSchema>;

export function createBroadcastTool(
	selfName: string,
	bus: MessageBus,
	maxMessagesPerAgent?: number,
): AgentTool<typeof broadcastSchema> {
	return {
		name: "broadcast",
		label: "Broadcast",
		description: "Send a message to all team members at once.",
		parameters: broadcastSchema,
		async execute(_toolCallId, params: BroadcastInput): Promise<AgentToolResult<unknown>> {
			const content = params.content?.trim();
			if (!content) {
				return errorResult("`content` is required.");
			}
			try {
				const delivered = await bus.broadcast(selfName, content, maxMessagesPerAgent);
				return okResult(`Broadcast delivered to ${delivered} teammate(s).`);
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
		},
	};
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
