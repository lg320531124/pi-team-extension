/**
 * GitWorktree: lightweight git worktree wrapper (~50 lines).
 *
 * oh-my-pi's isolation-runner.ts (16KB) supports nested repos, baseline
 * capture, delta patch, merge back — far more than team v1 needs. Here we
 * only create an isolated working copy, let a worker write in it, and
 * clean up. `git worktree add/remove` is enough.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorktreeLike } from "./types.js";

const exec = promisify(execFile);

export interface GitWorktreeOptions {
	/** Repo root to create the worktree from. */
	repoRoot: string;
	/** Logical name for the worktree (worker name). */
	name: string;
	/** Optional explicit path; default to a temp dir. */
	path?: string;
}

export class GitWorktree implements WorktreeLike {
	readonly path: string;
	readonly branch: string;

	private constructor(path: string, branch: string) {
		this.path = path;
		this.branch = branch;
	}

	/** Create a detached worktree on a fresh branch. */
	static async create(opts: GitWorktreeOptions): Promise<GitWorktree> {
		const snowflake = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		const branch = `team/${opts.name}/${snowflake}`;
		const path = opts.path ?? join(tmpdir(), `pi-team-${opts.name}-${snowflake}`);

		// Detached worktree on a new branch so workers don't touch the parent
		// repo's working tree or HEAD.
		await exec("git", ["worktree", "add", "--detach", "-b", branch, path], {
			cwd: opts.repoRoot,
		});
		return new GitWorktree(path, branch);
	}

	/** Capture the diff vs the parent repo's HEAD as a patch. */
	async captureDeltaPatch(): Promise<string> {
		const { stdout } = await exec("git", ["diff", "HEAD"], { cwd: this.path });
		return stdout;
	}

	/** Remove the worktree and delete its branch. */
	async cleanup(): Promise<void> {
		try {
			await exec("git", ["worktree", "remove", "--force", this.path], {
				cwd: this.path,
			});
		} catch {
			// worktree dir may already be gone
		}
		try {
			await exec("git", ["branch", "-D", this.branch], { cwd: this.path });
		} catch {
			// branch may already be deleted
		}
	}
}
