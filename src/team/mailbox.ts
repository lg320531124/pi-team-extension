/**
 * Per-agent mailbox: in-memory queue + JSON file persistence.
 *
 * Mirrors CC agent-teams' design: `~/.claude/teams/{team}/inboxes/{agent}.json`.
 * Here persisted to `~/.pi-teams/{team}/inboxes/{agent}.json`. Crash-recovery
 * can replay undelivered messages from the file.
 */
import { EventEmitter } from "node:events";
import { mkdir, appendFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MailboxLike, TeamMessage } from "./types.js";

export interface MailboxOptions {
	teamName: string;
	agentName: string;
	/** Max pending messages before push is rejected. Default 10. */
	capacity?: number;
	/** Disable file persistence (useful for tests). Default false. */
	persist?: boolean;
}

export class Mailbox extends EventEmitter implements MailboxLike {
	private queue: TeamMessage[] = [];
	private readonly filePath: string;
	private readonly capacity: number;
	private readonly persist: boolean;

	constructor(opts: MailboxOptions) {
		super();
		this.capacity = opts.capacity ?? 10;
		this.persist = opts.persist ?? true;
		this.filePath = join(
			homedir(),
			".pi-teams",
			opts.teamName,
			"inboxes",
			`${opts.agentName}.json`,
		);
	}

	/** Append a message. Returns false if the mailbox is at capacity. */
	async push(msg: TeamMessage): Promise<boolean> {
		if (this.queue.length >= this.capacity) {
			return false;
		}
		this.queue.push(msg);
		if (this.persist) {
			try {
				await mkdir(dirname(this.filePath), { recursive: true });
				await appendFile(this.filePath, JSON.stringify(msg) + "\n", "utf8");
			} catch {
				// Persistence is best-effort; in-memory queue is authoritative.
			}
		}
		this.emit("message");
		return true;
	}

	/** Return all pending messages and clear the in-memory queue. */
	drain(): TeamMessage[] {
		const out = this.queue;
		this.queue = [];
		return out;
	}

	peek(): TeamMessage[] {
		return [...this.queue];
	}

	size(): number {
		return this.queue.length;
	}

	/** Remove the persisted inbox file. Called on team shutdown. */
	async clearFile(): Promise<void> {
		if (!this.persist) return;
		try {
			await rm(this.filePath, { force: true });
		} catch {
			// best-effort
		}
	}
}
