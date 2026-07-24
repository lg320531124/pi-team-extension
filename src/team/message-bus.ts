/**
 * MessageBus: in-process routing + per-agent mailboxes + history.
 *
 * Same-process EventEmitter transport (v1). The API surface
 * (send/broadcast/register) is transport-agnostic — swapping to ZMQ
 * sockets later only changes the internals, not the callers.
 */
import { EventEmitter } from "node:events";
import { Mailbox } from "./mailbox.js";
import type { TeamMessage } from "./types.js";

export interface MessageBusEvents {
	message: (msg: TeamMessage) => void;
}

export class MessageBus extends EventEmitter {
	private readonly mailboxes = new Map<string, Mailbox>();
	private readonly history: TeamMessage[] = [];
	/** Counter of messages sent per agent — used for anti-loop caps. */
	private readonly sentCount = new Map<string, number>();

	register(name: string, mailbox: Mailbox): void {
		this.mailboxes.set(name, mailbox);
	}

	unregister(name: string): void {
		this.mailboxes.delete(name);
	}

	has(name: string): boolean {
		return this.mailboxes.has(name);
	}

	/** Known agent names (leader + workers). */
	roster(): string[] {
		return [...this.mailboxes.keys()];
	}

	sentBy(name: string): number {
		return this.sentCount.get(name) ?? 0;
	}

	/**
	 * Send a message from `from` to `to`. Returns false if the recipient is
	 * unknown or their mailbox rejected (full). Throws if the sender has
	 * exceeded its per-session message cap.
	 */
	async send(from: string, to: string, content: string, maxPerAgent?: number): Promise<boolean> {
		const count = (this.sentCount.get(from) ?? 0) + 1;
		if (maxPerAgent !== undefined && count > maxPerAgent) {
			throw new Error(
				`Agent "${from}" exceeded message cap (${maxPerAgent}). Possible infinite loop.`,
			);
		}
		this.sentCount.set(from, count);

		const msg: TeamMessage = {
			id: `${from}-${count}-${Date.now().toString(36)}`,
			from,
			to,
			content,
			timestamp: Date.now(),
		};

		const recipient = this.mailboxes.get(to);
		if (!recipient) {
			return false;
		}
		const ok = await recipient.push(msg);
		if (ok) {
			this.history.push(msg);
			this.emit("message", msg);
		}
		return ok;
	}

	/** Deliver to every registered mailbox except the sender. */
	async broadcast(from: string, content: string, maxPerAgent?: number): Promise<number> {
		let delivered = 0;
		for (const name of this.mailboxes.keys()) {
			if (name === from) continue;
			if (await this.send(from, name, content, maxPerAgent)) {
				delivered++;
			}
		}
		return delivered;
	}

	getHistory(): TeamMessage[] {
		return [...this.history];
	}

	async clearAllMailboxes(): Promise<void> {
		for (const mb of this.mailboxes.values()) {
			await mb.clearFile();
		}
	}
}
