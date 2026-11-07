import {
	CommitFailedError,
	CommitResult,
	DiffFile,
	GitStatus,
	NoRemoteError,
	NothingToCommitError,
	PullRequest,
	PullRequestCheck,
	type PullRequestCheckState,
	PullRequestComment,
	PullRequestConversation,
	PullRequestCreateError,
	PullRequestMergeError,
	type PullRequestMergeMethod,
	PullRequestNotFoundError,
	PullRequestReadError,
	PullRequestReview,
	PullRequestReviewError,
	type PullRequestReviewInput,
	PullRequestState,
	type PullRequestStatus,
	RemoteBranchDeleteError,
	PushFailedError,
	PushRejectedError,
	WorkspaceDiff,
} from "@repo/contracts/Git";
import {
	type ChangedPath,
	type LineCounts,
	parseNameStatus,
	parseNumstat,
	parsePatch,
	parseStatus,
	untrackedHunks,
} from "./parseGitOutput.ts";
import { Context, Effect, type FileSystem, Layer, Schema } from "effect";
import { type GhCommandError, requireGhLogin, runGh } from "./runGh.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { readWorkspaceFile } from "../files/readWorkspaceFile.ts";
import type { Workspace } from "@repo/contracts/Workspace";
import type { ChildProcessSpawner } from "effect/process";
import { leavesRoot } from "../files/leavesRoot.ts";
import { normalize } from "node:path";
import { runGit } from "./runGit.ts";

// The workspace diff sends at most this many changed lines per file and in total.
// Anything past that is listed as too large and loaded one file at a time.
export const DIFF_FILE_LINE_LIMIT = 2000;
export const DIFF_TOTAL_LINE_LIMIT = 20_000;
// Loading one file on request still stops here, to keep the webview responsive.
export const SINGLE_FILE_LINE_LIMIT = 50_000;
const UNTRACKED_BYTE_LIMIT = 1024 * 1024;

// Literal pathspecs, so names with *, ? or : are never read as patterns.
const pathspecs = (paths: ReadonlyArray<string>) => ["--", ...paths.map((path) => `:(literal)${path}`)];

// Check runs have a name, status, conclusion and detailsUrl. Legacy commit statuses have a context, state and targetUrl.
const GhCheck = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	context: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.String),
	conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
	state: Schema.optionalKey(Schema.String),
	detailsUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
	targetUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
type GhCheck = typeof GhCheck.Type;

const GhAuthor = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const GhConversation = Schema.fromJsonString(
	Schema.Struct({
		number: Schema.Int,
		statusCheckRollup: Schema.NullOr(Schema.Array(GhCheck)),
		comments: Schema.Array(
			Schema.Struct({ id: Schema.String, author: GhAuthor, body: Schema.String, createdAt: Schema.String }),
		),
		reviews: Schema.Array(
			Schema.Struct({
				id: Schema.String,
				author: GhAuthor,
				state: Schema.String,
				body: Schema.String,
				submittedAt: Schema.NullOr(Schema.String),
			}),
		),
	}),
);

const GhReviewComments = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			id: Schema.Int,
			user: GhAuthor,
			body: Schema.String,
			path: Schema.String,
			line: Schema.NullOr(Schema.Int),
			created_at: Schema.String,
		}),
	),
);

const GhPullRequest = Schema.fromJsonString(
	Schema.Struct({
		number: Schema.Int,
		url: Schema.String,
		title: Schema.String,
		state: PullRequestState,
		isDraft: Schema.Boolean,
		reviewDecision: Schema.NullOr(Schema.String),
		statusCheckRollup: Schema.NullOr(Schema.Array(GhCheck)),
	}),
);

const FAILED_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
	"ERROR",
]);

// Check runs report status and conclusion; legacy commit statuses report only state.
const checkState = (check: GhCheck): PullRequestCheckState => {
	const result = check.status === undefined ? check.state : check.status === "COMPLETED" ? check.conclusion : null;
	if (result === null || result === undefined || result === "" || result === "PENDING" || result === "EXPECTED") {
		return "pending";
	}
	return FAILED_CONCLUSIONS.has(result) ? "failing" : "passing";
};

const summarizeChecks = (checks: ReadonlyArray<GhCheck>) => {
	const summary = { passing: 0, failing: 0, pending: 0 };
	for (const check of checks) {
		summary[checkState(check)]++;
	}
	return summary;
};

const authorName = (author: typeof GhAuthor.Type) => author?.login ?? "ghost";

const MERGE_FLAGS = { squash: "--squash", merge: "--merge", rebase: "--rebase" } as const;
const REVIEW_FLAGS = { approve: "--approve", requestChanges: "--request-changes", comment: "--comment" } as const;

export class GitService extends Context.Service<GitService>()("swarm/daemon/git/GitService", {
	make: Effect.gen(function* () {
		const workspaces = yield* WorkspaceService;
		const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem>();

		// The point where the workspace left its base branch. Without one (unrelated histories, a missing
		// base branch) the diff falls back to HEAD and shows only uncommitted changes.
		const findMergeBase = (current: Workspace) =>
			runGit(current.path, ["merge-base", "HEAD", current.baseBranch]).pipe(
				Effect.catchTag("GitCommandError", (cause) =>
					Effect.logWarning("No merge base with the base branch, diffing against HEAD", cause).pipe(
						Effect.annotateLogs({ workspaceId: current.id }),
						Effect.as("HEAD"),
					),
				),
			);

		const untrackedFile = Effect.fn("GitService.untrackedFile")(function* (
			cwd: string,
			path: string,
			lineBudget: number,
		) {
			const base = { path, oldPath: null, status: "untracked", deletions: 0 } as const;
			const read = yield* readWorkspaceFile(cwd, path, UNTRACKED_BYTE_LIMIT).pipe(
				// Deleted since git listed it, or it resolves outside the workspace: leave it out.
				Effect.catchTag("FileNotFoundError", () =>
					Effect.logInfo("Left an untracked file out of the diff").pipe(Effect.annotateLogs({ path }), Effect.as(null)),
				),
			);
			if (read === null) {
				return null;
			}
			switch (read.kind) {
				case "tooLarge":
					return new DiffFile({ ...base, additions: 0, content: { kind: "tooLarge" } });
				case "binary":
					return new DiffFile({ ...base, additions: 0, content: { kind: "binary" } });
				case "symlink":
				case "text": {
					// Like git, a new symlink shows the path it points to.
					const hunks = untrackedHunks(read.kind === "text" ? read.text : read.target);
					const additions = hunks[0]?.lines.length ?? 0;
					return new DiffFile({
						...base,
						additions,
						content: additions > lineBudget ? { kind: "tooLarge" } : { kind: "text", hunks },
					});
				}
			}
		});

		const loadDiff = Effect.fn("GitService.loadDiff")(function* (
			current: Workspace,
			options: { readonly onlyPath: string | null; readonly fileLimit: number; readonly totalLimit: number },
		) {
			const { path: cwd } = current;
			const mergeBase = yield* findMergeBase(current);
			const only = options.onlyPath === null ? [] : pathspecs([options.onlyPath]);
			const [nameStatus, numstat, untrackedOutput] = yield* Effect.all([
				runGit(cwd, ["diff", "--name-status", "-z", "-M", mergeBase, ...only]),
				runGit(cwd, ["diff", "--numstat", "-z", "-M", mergeBase, ...only]),
				runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...only]),
			]);
			const counts = parseNumstat(numstat);
			let budget = options.totalLimit;
			const tracked = parseNameStatus(nameStatus).map((changed) => {
				const count = counts.get(changed.path) ?? { additions: 0, deletions: 0, binary: false };
				const lines = count.additions + count.deletions;
				const fits = !count.binary && lines <= options.fileLimit && lines <= budget;
				if (fits) {
					budget -= lines;
				}
				return { changed, count, fits };
			});

			const fitting = tracked.filter((file) => file.fits);
			const patch =
				fitting.length === 0
					? ""
					: yield* runGit(cwd, [
							"diff",
							"-M",
							"--no-color",
							"--no-ext-diff",
							mergeBase,
							...pathspecs(fitting.flatMap(({ changed }) => [changed.path, ...(changed.oldPath ?? [])])),
						]);
			const sections = parsePatch(patch);
			if (sections.length !== fitting.length) {
				yield* Effect.logWarning("The patch did not match the changed files, so hunks are left out").pipe(
					Effect.annotateLogs({ workspaceId: current.id, sections: sections.length, files: fitting.length }),
				);
			}
			const hunksByPath = new Map(
				sections.length === fitting.length ? fitting.map((file, index) => [file.changed.path, sections[index]]) : [],
			);

			const toDiffFile = ({ changed, count }: { changed: ChangedPath; count: LineCounts }) => {
				const section = hunksByPath.get(changed.path);
				return new DiffFile({
					...changed,
					additions: count.additions,
					deletions: count.deletions,
					content: count.binary
						? { kind: "binary" }
						: section === undefined
							? { kind: "tooLarge" }
							: { kind: "text", hunks: section.hunks },
				});
			};

			const untrackedPaths = untrackedOutput.split("\0").filter((path) => path !== "");
			const untracked: Array<DiffFile> = [];
			for (const path of untrackedPaths) {
				const file = yield* untrackedFile(cwd, path, Math.min(options.fileLimit, budget));
				if (file === null) {
					continue;
				}
				if (file.content.kind === "text") {
					budget -= file.additions;
				}
				untracked.push(file);
			}
			const files = [...tracked.map(toDiffFile), ...untracked]
				// Byte order, the same order git lists files in.
				.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
			return new WorkspaceDiff({ baseBranch: current.baseBranch, mergeBase, files });
		});

		const getWorkspaceDiff = Effect.fn("GitService.getWorkspaceDiff")(function* (workspaceId: string) {
			const current = yield* workspaces.get(workspaceId);
			return yield* loadDiff(current, {
				onlyPath: null,
				fileLimit: DIFF_FILE_LINE_LIMIT,
				totalLimit: DIFF_TOTAL_LINE_LIMIT,
			});
		}, Effect.provide(services));

		const getFileDiff = Effect.fn("GitService.getFileDiff")(function* (workspaceId: string, path: string) {
			const current = yield* workspaces.get(workspaceId);
			// Only paths inside the workspace can be part of its diff.
			if (leavesRoot(normalize(path))) {
				return null;
			}
			const diff = yield* loadDiff(current, {
				onlyPath: path,
				fileLimit: SINGLE_FILE_LINE_LIMIT,
				totalLimit: SINGLE_FILE_LINE_LIMIT,
			});
			return diff.files.find((file) => file.path === path) ?? null;
		}, Effect.provide(services));

		const getStatus = Effect.fn("GitService.getStatus")(function* (workspaceId: string) {
			const current = yield* workspaces.get(workspaceId);
			const output = yield* runGit(current.path, ["status", "--porcelain=v2", "--branch", "-z"]);
			return new GitStatus(parseStatus(output));
		}, Effect.provide(services));

		const commit = Effect.fn("GitService.commit")(function* (
			workspaceId: string,
			message: string,
			paths: ReadonlyArray<string> | null,
		) {
			const { path: cwd } = yield* workspaces.get(workspaceId);
			// null means every change. An empty list means none, never "all" through a bare `--`.
			if (paths !== null && paths.length === 0) {
				return yield* new NothingToCommitError();
			}
			const selected = paths === null ? [] : pathspecs(paths);
			yield* runGit(cwd, ["add", "--all", ...selected]);
			// diff --quiet exits 1 when something is staged.
			const nothingStaged = yield* runGit(cwd, ["diff", "--cached", "--quiet", ...selected]).pipe(
				Effect.as(true),
				Effect.catchTag("GitCommandError", (error) =>
					error.exitCode === 1 ? Effect.succeed(false) : Effect.fail(error),
				),
			);
			if (nothingStaged) {
				return yield* new NothingToCommitError();
			}
			yield* runGit(cwd, ["commit", "--message", message, ...selected]).pipe(
				Effect.catchTag("GitCommandError", (cause) =>
					Effect.logError("git commit failed", cause).pipe(Effect.andThen(Effect.fail(new CommitFailedError()))),
				),
			);
			const sha = yield* runGit(cwd, ["rev-parse", "HEAD"]);
			yield* Effect.logInfo("Committed").pipe(Effect.annotateLogs({ workspaceId, sha }));
			return new CommitResult({ sha });
		}, Effect.provide(services));

		const pushWorkspace = Effect.fn("GitService.pushWorkspace")(function* (current: Workspace) {
			const remotes = yield* runGit(current.path, ["remote"]);
			if (!remotes.split("\n").includes("origin")) {
				return yield* new NoRemoteError();
			}
			yield* runGit(current.path, ["push", "--set-upstream", "origin", current.branch]).pipe(
				Effect.catchTag("GitCommandError", (cause) => {
					const rejected = /\[rejected\]|non-fast-forward|fetch first/.test(cause.stderr);
					return Effect.logError("git push failed", cause).pipe(
						Effect.andThen(
							Effect.fail(
								rejected
									? new PushRejectedError({ branch: current.branch })
									: new PushFailedError({ branch: current.branch }),
							),
						),
					);
				}),
			);
			yield* Effect.logInfo("Pushed").pipe(Effect.annotateLogs({ workspaceId: current.id, branch: current.branch }));
		});

		const push = Effect.fn("GitService.push")(function* (workspaceId: string) {
			yield* pushWorkspace(yield* workspaces.get(workspaceId));
		}, Effect.provide(services));

		// With no argument, run in the workspace folder, gh finds the pull request of the checked-out branch
		// through the remote it pushes to. A branch argument would be read as a pull request number when it is
		// all digits, and would match a fork's branch of the same name. Everything after uses the number.
		const findPullRequest = Effect.fn("GitService.findPullRequest")(function* (current: Workspace) {
			const output = yield* runGh(current.path, [
				"pr",
				"view",
				"--json",
				"number,url,title,state,isDraft,reviewDecision,statusCheckRollup",
			]).pipe(
				Effect.map((found): string | null => found),
				Effect.catchTag("GhCommandError", (cause) =>
					/no pull requests found/i.test(cause.stderr)
						? Effect.succeed(null)
						: failGh(current.path, "gh pr view failed", new PullRequestReadError({ branch: current.branch }))(cause),
				),
			);
			if (output === null) {
				return null;
			}
			const found = yield* decodeGh(GhPullRequest, output, current.branch);
			return new PullRequest({
				number: found.number,
				url: found.url,
				title: found.title,
				state: found.state,
				isDraft: found.isDraft,
				reviewDecision: found.reviewDecision === "" ? null : found.reviewDecision,
				checks: summarizeChecks(found.statusCheckRollup ?? []),
			});
		});

		const requirePullRequestNumber = (current: Workspace) =>
			findPullRequest(current).pipe(
				Effect.flatMap((found) =>
					found === null
						? Effect.fail(new PullRequestNotFoundError({ branch: current.branch }))
						: Effect.succeed(String(found.number)),
				),
			);

		const getPullRequest = Effect.fn("GitService.getPullRequest")(function* (workspaceId: string) {
			const current = yield* workspaces.get(workspaceId);
			const found = yield* findPullRequest(current);
			if (found === null) {
				return { status: "none" } satisfies PullRequestStatus;
			}
			if (found.url !== current.pullRequestUrl) {
				yield* workspaces.setPullRequestUrl(workspaceId, found.url);
			}
			return { status: "found", pullRequest: found } satisfies PullRequestStatus;
		}, Effect.provide(services));

		const createPullRequest = Effect.fn("GitService.createPullRequest")(function* (
			workspaceId: string,
			details: { readonly title: string; readonly body: string; readonly draft: boolean },
		) {
			const current = yield* workspaces.get(workspaceId);
			// Checked first, so a missing login does not leave a pushed branch and no pull request.
			yield* requireGhLogin(current.path);
			yield* pushWorkspace(current);
			const output = yield* runGh(current.path, [
				"pr",
				"create",
				"--title",
				details.title,
				"--body",
				details.body,
				"--base",
				current.baseBranch,
				"--head",
				current.branch,
				...(details.draft ? ["--draft"] : []),
			]).pipe(
				Effect.catchTag("GhCommandError", (cause) =>
					Effect.logError("gh pr create failed", cause).pipe(
						Effect.andThen(Effect.fail(new PullRequestCreateError({ branch: current.branch }))),
					),
				),
			);
			const url = output
				.split("\n")
				.filter((line) => line.startsWith("https://"))
				.at(-1);
			if (url === undefined) {
				yield* Effect.logError("gh pr create printed no URL").pipe(Effect.annotateLogs({ output }));
				return yield* new PullRequestCreateError({ branch: current.branch });
			}
			yield* Effect.logInfo("Opened pull request").pipe(Effect.annotateLogs({ workspaceId, url }));
			return yield* workspaces.setPullRequestUrl(workspaceId, url);
		}, Effect.provide(services));

		// gh output that does not match its documented JSON is a gh change we need to know about.
		const decodeGh = <A>(schema: Schema.Codec<A, string>, output: string, branch: string) =>
			Schema.decodeUnknownEffect(schema)(output).pipe(
				Effect.catchTag("SchemaError", (cause) =>
					Effect.logError("Could not read gh output", cause).pipe(
						Effect.andThen(Effect.fail(new PullRequestReadError({ branch }))),
					),
				),
			);

		// Any gh failure: a missing login first, then the error the caller names.
		const failGh =
			<E>(cwd: string, message: string, error: E) =>
			(cause: GhCommandError) =>
				requireGhLogin(cwd).pipe(Effect.andThen(Effect.logError(message, cause)), Effect.andThen(Effect.fail(error)));

		const getPullRequestConversation = Effect.fn("GitService.getPullRequestConversation")(function* (
			workspaceId: string,
		) {
			const current = yield* workspaces.get(workspaceId);
			const { branch } = current;
			const number = yield* requirePullRequestNumber(current);
			const viewed = yield* runGh(current.path, [
				"pr",
				"view",
				number,
				"--json",
				"number,statusCheckRollup,comments,reviews",
			]).pipe(
				Effect.catchTag(
					"GhCommandError",
					failGh(current.path, "gh pr view failed", new PullRequestReadError({ branch })),
				),
			);
			const conversation = yield* decodeGh(GhConversation, viewed, branch);
			// gh fills in {owner}/{repo} from the repository's remote. 100 is GitHub's largest page.
			const lineComments = yield* runGh(current.path, [
				"api",
				`repos/{owner}/{repo}/pulls/${conversation.number}/comments?per_page=100`,
			]).pipe(
				Effect.catchTag("GhCommandError", failGh(current.path, "gh api failed", new PullRequestReadError({ branch }))),
				Effect.flatMap((output) => decodeGh(GhReviewComments, output, branch)),
			);
			return new PullRequestConversation({
				checks: (conversation.statusCheckRollup ?? []).map(
					(check) =>
						new PullRequestCheck({
							name: check.name ?? check.context ?? "Check",
							state: checkState(check),
							url: check.detailsUrl ?? check.targetUrl ?? null,
						}),
				),
				comments: conversation.comments.map(
					(comment) =>
						new PullRequestComment({
							id: comment.id,
							author: authorName(comment.author),
							body: comment.body,
							createdAt: comment.createdAt,
							path: null,
							line: null,
						}),
				),
				reviewComments: lineComments.map(
					(comment) =>
						new PullRequestComment({
							id: String(comment.id),
							author: authorName(comment.user),
							body: comment.body,
							createdAt: comment.created_at,
							path: comment.path,
							line: comment.line,
						}),
				),
				reviews: conversation.reviews.map(
					(review) =>
						new PullRequestReview({
							id: review.id,
							author: authorName(review.author),
							state: review.state,
							body: review.body,
							submittedAt: review.submittedAt,
						}),
				),
			});
		}, Effect.provide(services));

		const reviewPullRequest = Effect.fn("GitService.reviewPullRequest")(function* (
			workspaceId: string,
			review: PullRequestReviewInput,
		) {
			const current = yield* workspaces.get(workspaceId);
			const number = yield* requirePullRequestNumber(current);
			yield* runGh(current.path, [
				"pr",
				"review",
				number,
				REVIEW_FLAGS[review.verdict],
				...(review.body === "" ? [] : ["--body", review.body]),
			]).pipe(
				Effect.catchTag(
					"GhCommandError",
					failGh(current.path, "gh pr review failed", new PullRequestReviewError({ branch: current.branch })),
				),
			);
			yield* Effect.logInfo("Reviewed pull request").pipe(
				Effect.annotateLogs({ workspaceId, verdict: review.verdict }),
			);
		}, Effect.provide(services));

		const mergePullRequest = Effect.fn("GitService.mergePullRequest")(function* (
			workspaceId: string,
			method: PullRequestMergeMethod,
			deleteBranch: boolean,
		) {
			const current = yield* workspaces.get(workspaceId);
			const { branch } = current;
			const number = yield* requirePullRequestNumber(current);
			yield* runGh(current.path, ["pr", "merge", number, MERGE_FLAGS[method]]).pipe(
				Effect.catchTag(
					"GhCommandError",
					failGh(current.path, "gh pr merge failed", new PullRequestMergeError({ branch })),
				),
			);
			yield* Effect.logInfo("Merged pull request").pipe(Effect.annotateLogs({ workspaceId, method }));
			// Not gh's --delete-branch: it also switches the local checkout, which a worktree cannot do while the base
			// branch is checked out in the project folder. The local branch goes when the workspace is archived.
			if (deleteBranch) {
				yield* runGit(current.path, ["push", "origin", "--delete", branch]).pipe(
					Effect.catchTag("GitCommandError", (cause) =>
						Effect.logError("Could not delete the remote branch", cause).pipe(
							Effect.andThen(Effect.fail(new RemoteBranchDeleteError({ branch }))),
						),
					),
				);
			}
			return yield* getPullRequest(workspaceId);
		}, Effect.provide(services));

		return {
			getWorkspaceDiff,
			getFileDiff,
			getStatus,
			commit,
			push,
			getPullRequest,
			createPullRequest,
			getPullRequestConversation,
			reviewPullRequest,
			mergePullRequest,
		};
	}),
}) {
	static readonly layer = Layer.effect(GitService, GitService.make);
}
