/**
 * GitWorktree v2 unit tests — run with `bun test test/worktree.test.ts`.
 *
 * Uses a throwaway git repo under the OS temp dir; no real user repo touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { GitWorktree } from "../src/team/worktree.js";

const exec = promisify(execFile);

/** Deterministic commit identity so git commits work in throwaway repos. */
const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

/** Create a throwaway git repo with one seed commit on `main`. */
async function initRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "team-wt-"));
	await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await exec("git", ["config", "user.name", "test"], { cwd: dir });
	await writeFile(join(dir, "seed.txt"), "seed\n");
	await exec("git", ["add", "."], { cwd: dir });
	await exec("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
	return dir;
}

async function destroyRepo(repo: string): Promise<void> {
	await rm(repo, { recursive: true, force: true });
}

test("create: worktree lands under .pi/worktrees with stable branch", async () => {
	const repo = await initRepo();
	try {
		const wt = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		assert.ok(
			wt.path.startsWith(join(repo, ".pi", "worktrees")),
			`path should be inside .pi/worktrees, got ${wt.path}`,
		);
		assert.equal(wt.branch, "team/coder");
		assert.equal(wt.baseCommit.length, 40);
		assert.ok(existsSync(wt.path));
		// Fresh worktree at baseline → clean.
		assert.equal(await wt.contributionState(), "clean");
	} finally {
		await destroyRepo(repo);
	}
});

test("create: default baseRef falls back to local HEAD when no origin", async () => {
	const repo = await initRepo();
	try {
		const wt = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		// No origin configured → baseline = local HEAD (seed commit).
		const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repo });
		assert.equal(wt.baseCommit, stdout.trim());
	} finally {
		await destroyRepo(repo);
	}
});

test("contributionState: uncommitted change → modified", async () => {
	const repo = await initRepo();
	try {
		const wt = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		await writeFile(join(wt.path, "new.txt"), "hello\n");
		assert.equal(await wt.contributionState(), "modified");
	} finally {
		await destroyRepo(repo);
	}
});

test("contributionState + lastCommit: committed change → contributed", async () => {
	const repo = await initRepo();
	try {
		const wt = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		await writeFile(join(wt.path, "feature.txt"), "impl\n");
		await exec("git", ["add", "feature.txt"], { cwd: wt.path });
		await exec("git", ["commit", "-q", "-m", "add feature"], {
			cwd: wt.path,
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
		assert.equal(await wt.contributionState(), "contributed");
		const commit = await wt.lastCommit();
		assert.ok(commit);
		assert.equal(commit!.message, "add feature");
		assert.equal(commit!.hash.length, 40);
	} finally {
		await destroyRepo(repo);
	}
});

test("cleanup: preserves committed work when force=false", async () => {
	const repo = await initRepo();
	try {
		const wt = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		await writeFile(join(wt.path, "feature.txt"), "impl\n");
		await exec("git", ["add", "feature.txt"], { cwd: wt.path });
		await exec("git", ["commit", "-q", "-m", "add feature"], {
			cwd: wt.path,
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
		// Non-force cleanup must NOT delete a worktree with commits.
		await wt.cleanup();
		assert.ok(existsSync(wt.path), "worktree with commits must survive non-force cleanup");
		// Force cleanup removes it.
		await wt.cleanup(true);
		assert.ok(!existsSync(wt.path), "force cleanup should remove the worktree");
		// Branch deleted too.
		const branches = await exec("git", ["branch", "--list", "team/coder"], { cwd: repo });
		assert.equal(branches.stdout.trim(), "");
	} finally {
		await destroyRepo(repo);
	}
});

test("cleanup: preserves dirty work when force=false", async () => {
	const repo = await initRepo();
	try {
		const wt = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		await writeFile(join(wt.path, "new.txt"), "hello\n");
		await wt.cleanup();
		assert.ok(existsSync(wt.path), "dirty worktree must survive non-force cleanup");
		await wt.cleanup(true);
		assert.ok(!existsSync(wt.path));
	} finally {
		await destroyRepo(repo);
	}
});

test("cleanup: removes clean worktree without force", async () => {
	const repo = await initRepo();
	try {
		const wt = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		assert.equal(await wt.contributionState(), "clean");
		await wt.cleanup();
		assert.ok(!existsSync(wt.path), "clean worktree should be removed by plain cleanup");
	} finally {
		await destroyRepo(repo);
	}
});

test("find: reuses existing worktree with same baseline", async () => {
	const repo = await initRepo();
	try {
		const created = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		const found = await GitWorktree.find({ repoRoot: repo, name: "coder" });
		assert.ok(found, "find should locate an existing worktree");
		assert.equal(found!.path, created.path);
		assert.equal(found!.baseCommit, created.baseCommit);
		// After cleanup, find returns undefined.
		await found!.cleanup(true);
		const gone = await GitWorktree.find({ repoRoot: repo, name: "coder" });
		assert.equal(gone, undefined);
	} finally {
		await destroyRepo(repo);
	}
});

test("create: recreates after previous run left worktree behind", async () => {
	const repo = await initRepo();
	try {
		const first = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		await writeFile(join(first.path, "feature.txt"), "impl\n");
		// Simulate an interrupted run: worktree still on disk with changes.
		const second = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		assert.equal(second.branch, "team/coder");
		// Fresh worktree → clean state (stale content was reset).
		assert.equal(await second.contributionState(), "clean");
		assert.ok(!existsSync(join(second.path, "feature.txt")));
	} finally {
		await destroyRepo(repo);
	}
});

test("merge-back: coordinator-style merge of worker branch into main", async () => {
	const repo = await initRepo();
	try {
		const wt = await GitWorktree.create({ repoRoot: repo, name: "coder" });
		// Worker commits in its worktree.
		await writeFile(join(wt.path, "feature.txt"), "impl\n");
		await exec("git", ["add", "feature.txt"], { cwd: wt.path });
		await exec("git", ["commit", "-q", "-m", "add feature"], {
			cwd: wt.path,
			env: gitEnv,
		});
		assert.equal(await wt.contributionState(), "contributed");

		// Coordinator serializes the merge back into main (repoRoot cwd).
		await exec(
			"git",
			["merge", "--no-ff", wt.branch, "-m", "team: merge coder contribution"],
			{ cwd: repo },
		);

		// Main branch now carries the worker's file.
		assert.ok(existsSync(join(repo, "feature.txt")));
		const log = await exec("git", ["log", "--oneline", "-2"], { cwd: repo });
		assert.match(log.stdout, /team: merge coder contribution/);

		// Consumed worktree can be force-cleaned after the merge.
		await wt.cleanup(true);
		assert.ok(!existsSync(wt.path));
	} finally {
		await destroyRepo(repo);
	}
});

test("merge-back: conflicting merge fails and worktree is preserved", async () => {
	const repo = await initRepo();
	try {
		// Create the worktree FIRST so its baseline is the original seed.
		const wt = await GitWorktree.create({ repoRoot: repo, name: "coder" });

		// Main branch modifies seed.txt after the worktree's baseline.
		await writeFile(join(repo, "seed.txt"), "main change\n");
		await exec("git", ["add", "seed.txt"], { cwd: repo });
		await exec("git", ["commit", "-q", "-m", "main edit"], { cwd: repo, env: gitEnv });

		// Worker edits the same file differently.
		await writeFile(join(wt.path, "seed.txt"), "worker change\n");
		await exec("git", ["add", "seed.txt"], { cwd: wt.path });
		await exec("git", ["commit", "-q", "-m", "worker edit"], {
			cwd: wt.path,
			env: gitEnv,
		});

		// Merge conflicts → git exits non-zero.
		await assert.rejects(
			exec("git", ["merge", "--no-ff", wt.branch, "-m", "team: merge coder contribution"], {
				cwd: repo,
			}),
		);
		// Abort the merge, then verify the worktree branch is still intact.
		await exec("git", ["merge", "--abort"], { cwd: repo }).catch(() => {});
		assert.equal(await wt.contributionState(), "contributed");
		assert.ok(existsSync(wt.path));
	} finally {
		await destroyRepo(repo);
	}
});

test("create: throws when repoRoot is not a git repository", async () => {
	const dir = await mkdtemp(join(tmpdir(), "team-notgit-"));
	try {
		await assert.rejects(
			GitWorktree.create({ repoRoot: dir, name: "coder" }),
			/not a git repository|fatal/,
		);
	} finally {
		await destroyRepo(dir);
	}
});
