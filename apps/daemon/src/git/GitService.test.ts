import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { DIFF_FILE_LINE_LIMIT, GitService } from "./GitService.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { runServiceTest } from "../testing/runServiceTest.ts";
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { GhSettings } from "./runGh.ts";
import { runGit } from "./runGit.ts";
import { join } from "node:path";

// Reuses the repository at tempDir/repo when a test prepared one.
const createWorkspace = Effect.fn("createWorkspace")(function* (tempDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const projects = yield* ProjectService;
	const workspaces = yield* WorkspaceService;
	const repositoryPath = join(tempDir, "repo");
	if (!(yield* fs.exists(repositoryPath))) {
		yield* makeTestRepository(repositoryPath);
	}
	const project = yield* projects.add(repositoryPath);
	return yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
});

// A bare repository that the project pushes to as origin.
const addOrigin = Effect.fn("addOrigin")(function* (tempDir: string, repositoryPath: string) {
	const originPath = join(tempDir, "origin.git");
	yield* runGit(tempDir, ["init", "--bare", "--initial-branch=main", originPath]);
	yield* runGit(repositoryPath, ["remote", "add", "origin", originPath]);
	return originPath;
});

// A stand-in gh that answers from a script, so tests never reach GitHub.
const fakeGh = Effect.fn("fakeGh")(function* (tempDir: string, body: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = join(tempDir, "gh");
	yield* fs.writeFileString(path, `#!/bin/sh\necho "$@" >> "${tempDir}/gh.log"\n${body}\n`);
	yield* fs.chmod(path, 0o755);
	return path;
});

// What `gh pr view --json ...` prints in a workspace whose branch has pull request 7.
const foundJson = JSON.stringify({
	number: 7,
	url: "https://github.com/acme/repo/pull/7",
	title: "Add feature",
	state: "OPEN",
	isDraft: false,
	reviewDecision: "",
	statusCheckRollup: [],
});

describe("GitService diff", () => {
	test("shows committed, modified, deleted, renamed, untracked and binary changes against the base", async () => {
		const diff = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				// The base branch holds the files the workspace deletes and renames.
				const repositoryPath = join(tempDir, "repo");
				yield* makeTestRepository(repositoryPath);
				yield* fs.writeFileString(join(repositoryPath, "gone.txt"), "bye\n");
				yield* fs.writeFileString(join(repositoryPath, "old-name.txt"), "same content\nacross a rename\nfor git\n");
				yield* runGit(repositoryPath, ["add", "."]);
				yield* runGit(repositoryPath, ["commit", "-m", "base"]);
				const created = yield* createWorkspace(tempDir);
				const write = (path: string, text: string) => fs.writeFileString(join(created.path, path), text);
				yield* write("README.md", "hello\nworld\n");
				yield* fs.remove(join(created.path, "gone.txt"));
				yield* runGit(created.path, ["mv", "old-name.txt", "new-name.txt"]);
				yield* write("untracked.txt", "fresh\n");
				yield* fs.writeFile(join(created.path, "image.bin"), new Uint8Array([0, 1, 2, 0]));
				yield* write(".gitignore", "ignored.log\n");
				yield* write("ignored.log", "noise\n");
				return yield* Effect.flatMap(GitService, (git) => git.getWorkspaceDiff(created.id));
			}),
		);
		const byPath = new Map(diff.files.map((file) => [file.path, file]));
		expect(diff.baseBranch).toBe("main");
		expect([...byPath.keys()]).toEqual([
			".gitignore",
			"README.md",
			"gone.txt",
			"image.bin",
			"new-name.txt",
			"untracked.txt",
		]);
		expect(byPath.get("README.md")).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
		expect(byPath.get("README.md")?.content).toEqual({
			kind: "text",
			hunks: [
				{
					header: "@@ -1 +1,2 @@",
					lines: [
						{ kind: "context", oldLine: 1, newLine: 1, text: "hello" },
						{ kind: "add", oldLine: null, newLine: 2, text: "world" },
					],
				},
			],
		});
		expect(byPath.get("gone.txt")).toMatchObject({ status: "deleted", deletions: 1 });
		expect(byPath.get("new-name.txt")).toMatchObject({ status: "renamed", oldPath: "old-name.txt" });
		expect(byPath.get("untracked.txt")).toMatchObject({ status: "untracked", additions: 1 });
		expect(byPath.get("image.bin")?.content).toEqual({ kind: "binary" });
	});

	test("shows only the changed line of a file that was renamed and edited", async () => {
		const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
		const diff = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const repositoryPath = join(tempDir, "repo");
				yield* makeTestRepository(repositoryPath);
				yield* fs.writeFileString(join(repositoryPath, "notes"), `${lines.join("\n")}\n`);
				yield* runGit(repositoryPath, ["add", "."]);
				yield* runGit(repositoryPath, ["commit", "-m", "base"]);
				const created = yield* createWorkspace(tempDir);
				yield* runGit(created.path, ["mv", "notes", "journal"]);
				const edited = lines.map((line, index) => (index === 9 ? "line ten" : line));
				yield* fs.writeFileString(join(created.path, "journal"), `${edited.join("\n")}\n`);
				return yield* Effect.flatMap(GitService, (git) => git.getWorkspaceDiff(created.id));
			}),
		);
		const file = diff.files.find((changed) => changed.path === "journal");
		expect(file).toMatchObject({ status: "renamed", oldPath: "notes", additions: 1, deletions: 1 });
		const changedLines =
			file?.content.kind === "text"
				? file.content.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context")
				: [];
		expect(changedLines.map((line) => [line.kind, line.text])).toEqual([
			["delete", "line 10"],
			["add", "line ten"],
		]);
	});

	test("includes commits made in the workspace since it left the base branch", async () => {
		const diff = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const created = yield* createWorkspace(tempDir);
				yield* fs.writeFileString(join(created.path, "feature.txt"), "a\n");
				yield* runGit(created.path, ["add", "."]);
				yield* runGit(created.path, ["commit", "-m", "feature"]);
				return yield* Effect.flatMap(GitService, (git) => git.getWorkspaceDiff(created.id));
			}),
		);
		expect(diff.files.map((file) => [file.path, file.status])).toEqual([["feature.txt", "added"]]);
	});

	test("leaves a huge file out of the summary and loads it on request", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const git = yield* GitService;
				const created = yield* createWorkspace(tempDir);
				const lines = Array.from({ length: DIFF_FILE_LINE_LIMIT + 1 }, (_, line) => `line ${line}`).join("\n");
				yield* fs.writeFileString(join(created.path, "big.txt"), `${lines}\n`);
				yield* runGit(created.path, ["add", "."]);
				yield* fs.writeFileString(join(created.path, "small.txt"), "small\n");
				return {
					diff: yield* git.getWorkspaceDiff(created.id),
					single: yield* git.getFileDiff(created.id, "big.txt"),
				};
			}),
		);
		const [big, small] = result.diff.files;
		expect(big).toMatchObject({ path: "big.txt", additions: DIFF_FILE_LINE_LIMIT + 1, content: { kind: "tooLarge" } });
		expect(small?.content.kind).toBe("text");
		expect(result.single?.content.kind).toBe("text");
	});
});

describe("GitService commit and push", () => {
	test("commits only the selected files, then everything", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const git = yield* GitService;
				const created = yield* createWorkspace(tempDir);
				yield* fs.writeFileString(join(created.path, "a.txt"), "a\n");
				yield* fs.writeFileString(join(created.path, "b.txt"), "b\n");
				const none = yield* Effect.flip(git.commit(created.id, "no files", []));
				yield* git.commit(created.id, "add a", ["a.txt"]);
				const afterFirst = yield* runGit(created.path, ["status", "--porcelain"]);
				const second = yield* git.commit(created.id, "add the rest", null);
				const nothing = yield* Effect.flip(git.commit(created.id, "again", null));
				return {
					none,
					afterFirst,
					second,
					nothing,
					head: yield* runGit(created.path, ["rev-parse", "HEAD"]),
					log: yield* runGit(created.path, ["log", "--format=%s", "-2"]),
					status: yield* git.getStatus(created.id),
				};
			}),
		);
		expect(result.none._tag).toBe("NothingToCommitError");
		expect(result.afterFirst).toBe("?? b.txt");
		expect(result.second.sha).toBe(result.head);
		expect(result.log).toBe("add the rest\nadd a");
		expect(result.nothing._tag).toBe("NothingToCommitError");
		expect(result.status).toMatchObject({ branch: "feature", upstream: null, changedFiles: 0 });
	});

	test("pushes with an upstream, then reports how far ahead the branch is", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const git = yield* GitService;
				const created = yield* createWorkspace(tempDir);
				const origin = yield* addOrigin(tempDir, join(tempDir, "repo"));
				yield* git.push(created.id);
				yield* runGit(created.path, ["commit", "--allow-empty", "-m", "more"]);
				return {
					status: yield* git.getStatus(created.id),
					remoteBranch: yield* runGit(origin, ["branch", "--list", "feature"]),
				};
			}),
		);
		expect(result.remoteBranch).toContain("feature");
		expect(result.status).toMatchObject({ upstream: "origin/feature", ahead: 1, behind: 0 });
	});

	test("explains a missing remote and a rejected push", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const git = yield* GitService;
				const created = yield* createWorkspace(tempDir);
				const noRemote = yield* Effect.flip(git.push(created.id));
				const origin = yield* addOrigin(tempDir, join(tempDir, "repo"));
				// Someone else pushed a different feature branch first.
				const other = yield* makeTestRepository(join(tempDir, "other"));
				yield* runGit(other, ["commit", "--allow-empty", "-m", "theirs"]);
				yield* runGit(other, ["push", origin, "main:feature"]);
				return { noRemote, rejected: yield* Effect.flip(git.push(created.id)) };
			}),
		);
		expect(result.noRemote._tag).toBe("NoRemoteError");
		expect(result.rejected._tag).toBe("PushRejectedError");
	});
});

describe("GitService pull requests", () => {
	test("reports a missing gh", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const created = yield* createWorkspace(tempDir);
				return yield* Effect.flatMap(GitService, (git) => Effect.flip(git.getPullRequest(created.id)));
			}).pipe(Effect.provideService(GhSettings, { executable: "/nonexistent/gh" })),
		);
		expect(error._tag).toBe("GhNotInstalledError");
	});

	test("refuses to push or open a pull request when gh is signed out", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const created = yield* createWorkspace(tempDir);
				const origin = yield* addOrigin(tempDir, join(tempDir, "repo"));
				const executable = yield* fakeGh(tempDir, "exit 1");
				const error = yield* Effect.flatMap(GitService, (git) =>
					Effect.flip(git.createPullRequest(created.id, { title: "t", body: "", draft: false })),
				).pipe(Effect.provideService(GhSettings, { executable }));
				return { error, remoteBranches: yield* runGit(origin, ["branch", "--list"]) };
			}),
		);
		expect(result.error._tag).toBe("GhNotAuthenticatedError");
		expect(result.remoteBranches).toBe("");
	});

	test("pushes, opens the pull request, stores its URL and reads its status", async () => {
		const prJson = JSON.stringify({
			number: 7,
			url: "https://github.com/acme/repo/pull/7",
			title: "Add feature",
			state: "OPEN",
			isDraft: true,
			reviewDecision: "",
			statusCheckRollup: [
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ status: "IN_PROGRESS", conclusion: "" },
				{ status: "COMPLETED", conclusion: "FAILURE" },
				{ state: "SUCCESS" },
			],
		});
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const git = yield* GitService;
				const created = yield* createWorkspace(tempDir);
				const origin = yield* addOrigin(tempDir, join(tempDir, "repo"));
				const executable = yield* fakeGh(
					tempDir,
					[
						'case "$1 $2" in',
						'  "auth status") exit 0 ;;',
						'  "pr create") echo "Creating pull request"; echo "https://github.com/acme/repo/pull/7" ;;',
						`  "pr view") [ -f "${tempDir}/created" ] || { echo "no pull requests found for branch" >&2; exit 1; }; echo '${prJson}' ;;`,
						"esac",
						`[ "$2" = create ] && touch "${tempDir}/created"`,
						"exit 0",
					].join("\n"),
				);
				return yield* Effect.gen(function* () {
					const before = yield* git.getPullRequest(created.id);
					const updated = yield* git.createPullRequest(created.id, { title: "Add feature", body: "Body", draft: true });
					return {
						before,
						updated,
						after: yield* git.getPullRequest(created.id),
						remoteBranch: yield* runGit(origin, ["branch", "--list", "feature"]),
						ghLog: yield* fs.readFileString(join(tempDir, "gh.log")),
					};
				}).pipe(Effect.provideService(GhSettings, { executable }));
			}),
		);
		expect(result.before).toEqual({ status: "none" });
		expect(result.updated.pullRequestUrl).toBe("https://github.com/acme/repo/pull/7");
		expect(result.remoteBranch).toContain("feature");
		expect(result.ghLog).toContain("pr create --title Add feature --body Body --base main --head feature --draft");
		// No branch argument: gh would read a branch named only with digits as a pull request number.
		expect(result.ghLog).toContain("pr view --json number,url");
		expect(result.after).toMatchObject({
			status: "found",
			pullRequest: { number: 7, isDraft: true, reviewDecision: null, checks: { passing: 2, failing: 1, pending: 1 } },
		});
	});

	test("reads checks one by one, the conversation, reviews and line comments", async () => {
		const viewJson = JSON.stringify({
			number: 7,
			statusCheckRollup: [
				{ name: "build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/build" },
				{ context: "deploy", state: "PENDING", targetUrl: null },
			],
			comments: [{ id: "IC_1", author: { login: "ana" }, body: "Nice", createdAt: "2026-01-01T00:00:00Z" }],
			reviews: [
				{ id: "PRR_1", author: null, state: "CHANGES_REQUESTED", body: "Fix it", submittedAt: "2026-01-02T00:00:00Z" },
			],
		});
		const commentsJson = JSON.stringify([
			{ id: 11, user: { login: "bo" }, body: "Rename this", path: "src/a.ts", line: 4, created_at: "2026-01-03" },
		]);
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const created = yield* createWorkspace(tempDir);
				const executable = yield* fakeGh(
					tempDir,
					[
						`[ "$1" = api ] && echo '${commentsJson}'`,
						`[ "$1 $2 $3" = "pr view --json" ] && echo '${foundJson}'`,
						`[ "$1 $2 $3" = "pr view 7" ] && echo '${viewJson}'`,
						"exit 0",
					].join("\n"),
				);
				const conversation = yield* Effect.flatMap(GitService, (git) =>
					git.getPullRequestConversation(created.id),
				).pipe(Effect.provideService(GhSettings, { executable }));
				return { conversation, ghLog: yield* fs.readFileString(join(tempDir, "gh.log")) };
			}),
		);
		expect(result.conversation.checks).toEqual([
			{ name: "build", state: "failing", url: "https://ci/build" },
			{ name: "deploy", state: "pending", url: null },
		]);
		expect(result.conversation.comments).toEqual([
			{ id: "IC_1", author: "ana", body: "Nice", createdAt: "2026-01-01T00:00:00Z", path: null, line: null },
		]);
		expect(result.conversation.reviews[0]).toMatchObject({ author: "ghost", state: "CHANGES_REQUESTED" });
		expect(result.conversation.reviewComments).toEqual([
			{ id: "11", author: "bo", body: "Rename this", createdAt: "2026-01-03", path: "src/a.ts", line: 4 },
		]);
		expect(result.ghLog).toContain("pr view 7 --json");
		expect(result.ghLog).toContain("api repos/{owner}/{repo}/pulls/7/comments?per_page=100");
	});

	test("reports a branch with no pull request", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const created = yield* createWorkspace(tempDir);
				const executable = yield* fakeGh(tempDir, 'echo "no pull requests found for branch" >&2; exit 1');
				return yield* Effect.flatMap(GitService, (git) => Effect.flip(git.getPullRequestConversation(created.id))).pipe(
					Effect.provideService(GhSettings, { executable }),
				);
			}),
		);
		expect(error._tag).toBe("PullRequestNotFoundError");
	});

	test("submits reviews with gh pr review", async () => {
		const ghLog = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const created = yield* createWorkspace(tempDir);
				const executable = yield* fakeGh(tempDir, `[ "$1 $2" = "pr view" ] && echo '${foundJson}'\nexit 0`);
				yield* Effect.gen(function* () {
					const git = yield* GitService;
					yield* git.reviewPullRequest(created.id, { verdict: "approve", body: "" });
					yield* git.reviewPullRequest(created.id, { verdict: "requestChanges", body: "Add tests" });
				}).pipe(Effect.provideService(GhSettings, { executable }));
				return yield* fs.readFileString(join(tempDir, "gh.log"));
			}),
		);
		// By number: gh would read a branch named only with digits as a pull request number.
		expect(ghLog.split("\n").filter((line) => line.startsWith("pr review"))).toEqual([
			"pr review 7 --approve",
			"pr review 7 --request-changes --body Add tests",
		]);
	});

	test("merges, deletes the branch on origin and returns the merged pull request", async () => {
		const merged = JSON.stringify({
			number: 7,
			url: "https://github.com/acme/repo/pull/7",
			title: "Add feature",
			state: "MERGED",
			isDraft: false,
			reviewDecision: "APPROVED",
			statusCheckRollup: [],
		});
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const git = yield* GitService;
				const created = yield* createWorkspace(tempDir);
				const origin = yield* addOrigin(tempDir, join(tempDir, "repo"));
				yield* git.push(created.id);
				const executable = yield* fakeGh(
					tempDir,
					[
						`[ "$1 $2 $3 $4 $5" = "pr view 7 --json headRefName" ] && echo '{"headRefName":"feature"}' && exit 0`,
						`[ "$1 $2" = "pr view" ] && echo '${merged}'`,
						"exit 0",
					].join("\n"),
				);
				const status = yield* git
					.mergePullRequest(created.id, "squash", true)
					.pipe(Effect.provideService(GhSettings, { executable }));
				return {
					status,
					remoteBranches: yield* runGit(origin, ["branch", "--list"]),
					ghLog: yield* fs.readFileString(join(tempDir, "gh.log")),
				};
			}),
		);
		expect(result.ghLog).toContain("pr merge 7 --squash");
		expect(result.remoteBranches).toBe("");
		expect(result.status).toMatchObject({ status: "found", pullRequest: { state: "MERGED" } });
	});

	test("keeps the branch on origin when the pull request's head is another branch", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const git = yield* GitService;
				const created = yield* createWorkspace(tempDir);
				const origin = yield* addOrigin(tempDir, join(tempDir, "repo"));
				yield* git.push(created.id);
				const executable = yield* fakeGh(
					tempDir,
					[
						`[ "$1 $2 $3 $4 $5" = "pr view 7 --json headRefName" ] && echo '{"headRefName":"other"}' && exit 0`,
						`[ "$1 $2" = "pr view" ] && echo '${foundJson}'`,
						"exit 0",
					].join("\n"),
				);
				const error = yield* Effect.flip(git.mergePullRequest(created.id, "squash", true)).pipe(
					Effect.provideService(GhSettings, { executable }),
				);
				return { error, remoteBranches: yield* runGit(origin, ["branch", "--list"]) };
			}),
		);
		expect(result.error).toMatchObject({ _tag: "RemoteBranchDeleteError", branch: "other" });
		expect(result.remoteBranches).toContain("feature");
	});

	test("refuses to push, open, review or merge after the worktree switched branches", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const git = yield* GitService;
				const created = yield* createWorkspace(tempDir);
				const origin = yield* addOrigin(tempDir, join(tempDir, "repo"));
				const executable = yield* fakeGh(
					tempDir,
					[
						'[ "$1" = auth ] && exit 0',
						`[ "$1 $2" = "pr view" ] && echo '${foundJson}' && exit 0`,
						'[ "$1 $2" = "pr create" ] && echo "https://github.com/acme/repo/pull/7"',
						"exit 0",
					].join("\n"),
				);
				// Someone switched branches from a terminal inside the worktree.
				yield* runGit(created.path, ["switch", "-c", "elsewhere"]);
				const errors = yield* Effect.all([
					Effect.flip(git.push(created.id)),
					Effect.flip(git.createPullRequest(created.id, { title: "t", body: "", draft: false })),
					Effect.flip(git.reviewPullRequest(created.id, { verdict: "approve", body: "" })),
					Effect.flip(git.mergePullRequest(created.id, "squash", true)),
				]).pipe(Effect.provideService(GhSettings, { executable }));
				yield* runGit(created.path, ["switch", "--detach"]);
				const detached = yield* Effect.flip(git.push(created.id));
				const ghLog = yield* fs.readFileString(join(tempDir, "gh.log")).pipe(Effect.orElseSucceed(() => ""));
				return { errors, detached, ghLog, remoteBranches: yield* runGit(origin, ["branch", "--list"]) };
			}),
		);
		for (const error of result.errors) {
			expect(error).toMatchObject({ _tag: "BranchChangedError", expected: "feature", actual: "elsewhere" });
		}
		expect(result.errors[0]?.message).toBe(
			"This workspace is on elsewhere, but Den set it up on feature. Switch back to feature, or start a new workspace.",
		);
		expect(result.detached).toMatchObject({ _tag: "BranchChangedError", expected: "feature", actual: null });
		expect(result.remoteBranches).toBe("");
		expect(result.ghLog).not.toContain("pr create");
		expect(result.ghLog).not.toContain("pr review");
		expect(result.ghLog).not.toContain("pr merge");
	});

	test("reports a merge that gh refused", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const created = yield* createWorkspace(tempDir);
				const executable = yield* fakeGh(
					tempDir,
					`[ "$1" = auth ] && exit 0\n[ "$1 $2" = "pr view" ] && echo '${foundJson}' && exit 0\nexit 1`,
				);
				return yield* Effect.flatMap(GitService, (git) =>
					Effect.flip(git.mergePullRequest(created.id, "rebase", false)),
				).pipe(Effect.provideService(GhSettings, { executable }));
			}),
		);
		expect(error._tag).toBe("PullRequestMergeError");
	});
});

describe("GitService diff never leaves the workspace", () => {
	test("shows a new symlink as its target and refuses paths outside", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const git = yield* GitService;
				const created = yield* createWorkspace(tempDir);
				yield* fs.symlink("/etc/hosts", join(created.path, "hosts-link"));
				yield* fs.writeFileString(join(tempDir, "secret.txt"), "outside\n");
				return {
					diff: yield* git.getWorkspaceDiff(created.id),
					outside: yield* git.getFileDiff(created.id, "../secret.txt"),
					absolute: yield* git.getFileDiff(created.id, "/etc/hosts"),
				};
			}),
		);
		expect(result.diff.files).toHaveLength(1);
		expect(result.diff.files[0]?.content).toEqual({
			kind: "text",
			hunks: [{ header: "@@ -0,0 +1,1 @@", lines: [{ kind: "add", oldLine: null, newLine: 1, text: "/etc/hosts" }] }],
		});
		expect(result.outside).toBeNull();
		expect(result.absolute).toBeNull();
	});
});
