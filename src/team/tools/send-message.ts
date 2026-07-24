/**
 * send_message tool: send a text message to a named teammate.
 *
 * Any agent can message any other agent directly — no leader routing.
 * Mirrors CC agent-teams' SendMessage.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { TextContent } from "@earendil-works/pi-ai";
import type { MessageBus } from "../message-bus.js";

const sendSchema = Type.Object({
	to: Type.String({ description: "Name of the teammate to message (e.g. 'coder', 'reviewer', or 'leader')" }),
	content: Type.String({ description: "The message content. Be specific and actionable." }),
});

type SendInput = Static<typeof sendSchema>;

export function createSendMessageTool(
	selfName: string,
	bus: MessageBus,
	maxMessagesPerAgent?: number,
): AgentTool<typeof sendSchema> {
	return {
		name: "send_message",
		label: "Send Message",
		description:
			"Send a message to another team member. Use this to share findings, ask questions, request help, or report results. You can message anyone directly — you do not need to route through the leader.",
		parameters: sendSchema,
		async execute(_toolCallId, params: SendInput): Promise<AgentToolResult<unknown>> {
			const to = params.to?.trim();
			const content = params.content?.trim();
			if (!to || !content) {
				return errorResult("`to` and `content` are required.");
			}
			if (!bus.has(to)) {
				return errorResult(`No teammate named "${to}". Known members: ${bus.roster().join(", ")}.`);
			}
			try {
				const ok = await bus.send(selfName, to, content, maxMessagesPerAgent);
				if (!ok) {
					return errorResult(
						`Recipient "${to}" mailbox is full. They have too many pending messages. Try again later or send to someone else.`,
					);
				}
				return okResult(`Message delivered to ${to}.`);
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
