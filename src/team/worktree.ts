/**
 * GitWorktree v2: project-internal isolation with contribution tracking.
 *
 * Design (mirrors Claude Code worktrees):
 *  - Worktrees live under `<repoRoot>/.pi/worktrees/<name>` (not /tmp) so
 *    worker output is discoverable and survives the run.
 *  - Stable branch name `team/<name>` per worker; reusing the same name
 *    reuses the worktree (interrupted runs can be resumed).
 *  - Contribution state is derived by diffing the worktree HEAD against
 *    the base commit captured at creation: committed / dirty / clean.
 *  - cleanup() never deletes a worktree that holds commits or uncommitted
 *    changes unless force=true — worker output is never silently lost.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { ContributionState, WorktreeLike } from "./types.js";

export type { ContributionState } from "./types.js";

const exec = promisify(execFile);

export interface GitWorktreeOptions {
	/** Repo root (git repo). */
	repoRoot: string;
	/** Stable logical name = worker name. */
	name: string;
	/** Optional worktrees root; default `<repoRoot>/.pi/worktrees`. */
	worktreesRoot?: string;
	/**
	 * Base ref for the new worktree:
	 *  - "fresh" (default): origin/HEAD if resolvable, else local HEAD
	 *  - "head": local HEAD (carries uncommitted-push state)
	 */
	baseRef?: "fresh" | "head";
}

export class GitWorktree implements WorktreeLike {
	readonly path: string;
	readonly branch: string;
	readonly baseCommit: string;
	readonly repoRoot: string;
	readonly worktreesRoot: string;

	private constructor(opts: GitWorktreeOptions & { baseCommit: string }) {
		this.repoRoot = opts.repoRoot;
		this.worktreesRoot = opts.worktreesRoot ?? join(opts.repoRoot, ".pi", "worktrees");
		this.branch = `team/${opts.name}`;
		this.path = join(this.worktreesRoot, opts.name);
		this.baseCommit = opts.baseCommit;
	}

	/** Create (or reset) the worker worktree on a stable `team/<name>` branch. */
	static async create(opts: GitWorktreeOptions): Promise<GitWorktree> {
		const worktreesRoot = opts.worktreesRoot ?? join(opts.repoRoot, ".pi", "worktrees");
		const branch = `team/${opts.name}`;
		const path = join(worktreesRoot, opts.name);

		// Sanity: repoRoot must be a git repository.
		await exec("git", ["rev-parse", "--git-dir"], { cwd: opts.repoRoot });

		// Drop a stale directory left by a previous failed cleanup, and a stale
		// stable branch from a previous run (the coordinator calls find() first,
		// so reaching create() means we want a fresh worktree).
		if (existsSync(path)) {
			await exec("git", ["worktree", "remove", "--force", path], {
				cwd: opts.repoRoot,
			}).catch(() => {});
		}
		await mkdir(worktreesRoot, { recursive: true });
		await exec("git", ["branch", "-D", branch], { cwd: opts.repoRoot }).catch(() => {});

		// Base ref resolution.
		let base: string;
		if (opts.baseRef === "head") {
			base = "HEAD";
		} else {
			const verify = await exec("git", ["rev-parse", "--verify", "origin/HEAD"], {
				cwd: opts.repoRoot,
			}).catch(() => ({ stdout: "HEAD" }));
			base = verify.stdout.trim();
		}

		await exec(
			"git",
			["worktree", "add", "-b", branch, path, base],
			{ cwd: opts.repoRoot },
		);

		const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: path });
		const baseCommit = stdout.trim();
		const wt = new GitWorktree({ ...opts, worktreesRoot, baseCommit });

		// Persist the baseline in the worktree's own gitdir so find() can
		// restore it later (outside the working tree → never pollutes git status).
		await wt.writeBaseMarker(baseCommit);
		return wt;
	}

	/** Reuse an existing worktree for this name, if present. */
	static async find(opts: GitWorktreeOptions): Promise<GitWorktree | undefined> {
		const worktreesRoot = opts.worktreesRoot ?? join(opts.repoRoot, ".pi", "worktrees");
		const path = join(worktreesRoot, opts.name);
		if (!existsSync(path)) return undefined;
		try {
			await exec("git", ["rev-parse", "--git-dir"], { cwd: path });
		} catch {
			return undefined;
		}
		const baseCommit = await readBaseMarker(opts.repoRoot, path);
		return new GitWorktree({ ...opts, worktreesRoot, baseCommit });
	}

	/** Compare worktree HEAD vs baseCommit. */
	async contributionState(): Promise<ContributionState> {
		const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: this.path });
		if (stdout.trim() !== this.baseCommit) return "contributed";
		const status = await exec("git", ["status", "--porcelain"], { cwd: this.path });
		if (status.stdout.trim() !== "") return "modified";
		return "clean";
	}

	/** Latest commit relative to baseCommit, if any. */
	async lastCommit(): Promise<{ hash: string; message: string } | null> {
		const state = await this.contributionState();
		if (state !== "contributed") return null;
		const { stdout } = await exec(
			"git",
			["log", "-1", "--format=%H%x00%s", "HEAD"],
			{ cwd: this.path },
		);
		const [hash, message] = stdout.trim().split("\0");
		return { hash, message: message ?? "" };
	}

	/**
	 * Remove the worktree and its branch.
	 * Preserves the worktree (returns silently) when it holds commits or
	 * uncommitted changes unless force=true.
	 */
	async cleanup(force = false): Promise<void> {
		const state = await this.contributionState();
		if (!force && state !== "clean") return;
		try {
			await exec("git", ["worktree", "remove", "--force", this.path], {
				cwd: this.repoRoot,
			});
		} catch {
			// worktree dir may already be gone
		}
		try {
			await exec("git", ["branch", "-D", this.branch], { cwd: this.repoRoot });
		} catch {
			// branch may already be deleted
		}
	}

	private async writeBaseMarker(baseCommit: string): Promise<void> {
		const marker = await baseMarkerPath(this.repoRoot, this.path);
		await writeFile(marker, baseCommit, "utf8");
	}
}

/** Marker file lives in the worktree's gitdir: `<repoRoot>/.git/worktrees/<name>/pi-team-base`. */
async function baseMarkerPath(repoRoot: string, worktreePath: string): Promise<string> {
	const { stdout } = await exec("git", ["rev-parse", "--git-dir"], { cwd: worktreePath });
	const gitDir = stdout.trim();
	const absolute = isAbsolute(gitDir) ? gitDir : resolve(repoRoot, gitDir);
	return join(absolute, "pi-team-base");
}

async function readBaseMarker(repoRoot: string, worktreePath: string): Promise<string> {
	try {
		const marker = await baseMarkerPath(repoRoot, worktreePath);
		const content = await readFile(marker, "utf8");
		const base = content.trim();
		if (base.length > 0) return base;
	} catch {
		// marker missing (legacy worktree) → fall through
	}
	// Fallback: treat current HEAD as baseline (conservative: no false positives).
	const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
	return stdout.trim();
}
