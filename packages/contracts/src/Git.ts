import { Schema } from "effect";

export const DiffLine = Schema.Struct({
	kind: Schema.Literals(["context", "add", "delete"]),
	oldLine: Schema.NullOr(Schema.Int),
	newLine: Schema.NullOr(Schema.Int),
	text: Schema.String,
});
export type DiffLine = typeof DiffLine.Type;

export const DiffHunk = Schema.Struct({
	header: Schema.String,
	lines: Schema.Array(DiffLine),
});
export type DiffHunk = typeof DiffHunk.Type;

export const DiffFileStatus = Schema.Literals(["added", "deleted", "modified", "renamed", "untracked"]);
export type DiffFileStatus = typeof DiffFileStatus.Type;

// Big files are summarized instead of sent, so one generated file cannot stall the view.
export const DiffContent = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("text"), hunks: Schema.Array(DiffHunk) }),
	Schema.Struct({ kind: Schema.Literal("binary") }),
	Schema.Struct({ kind: Schema.Literal("tooLarge") }),
]);
export type DiffContent = typeof DiffContent.Type;

export class DiffFile extends Schema.Class<DiffFile>("DiffFile")({
	path: Schema.String,
	oldPath: Schema.NullOr(Schema.String),
	status: DiffFileStatus,
	additions: Schema.Int,
	deletions: Schema.Int,
	content: DiffContent,
}) {}

// Everything the workspace changed since it left its base branch, committed or not.
export class WorkspaceDiff extends Schema.Class<WorkspaceDiff>("WorkspaceDiff")({
	baseBranch: Schema.String,
	mergeBase: Schema.String,
	files: Schema.Array(DiffFile),
}) {}

export class GitStatus extends Schema.Class<GitStatus>("GitStatus")({
	branch: Schema.String,
	upstream: Schema.NullOr(Schema.String),
	ahead: Schema.Int,
	behind: Schema.Int,
	changedFiles: Schema.Int,
}) {}

export const PullRequestState = Schema.Literals(["OPEN", "CLOSED", "MERGED"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestChecks = Schema.Struct({
	passing: Schema.Int,
	failing: Schema.Int,
	pending: Schema.Int,
});
export type PullRequestChecks = typeof PullRequestChecks.Type;

export class PullRequest extends Schema.Class<PullRequest>("PullRequest")({
	number: Schema.Int,
	url: Schema.String,
	title: Schema.String,
	state: PullRequestState,
	isDraft: Schema.Boolean,
	reviewDecision: Schema.NullOr(Schema.String),
	checks: PullRequestChecks,
}) {}

export const PullRequestStatus = Schema.Union([
	Schema.Struct({ status: Schema.Literal("none") }),
	Schema.Struct({ status: Schema.Literal("found"), pullRequest: PullRequest }),
]);
export type PullRequestStatus = typeof PullRequestStatus.Type;

export class CommitResult extends Schema.Class<CommitResult>("CommitResult")({
	sha: Schema.String,
}) {}

export class NothingToCommitError extends Schema.TaggedError<NothingToCommitError>()("NothingToCommitError", {}) {
	override get message() {
		return "There is nothing to commit. Change a file first.";
	}
}

export class CommitFailedError extends Schema.TaggedError<CommitFailedError>()("CommitFailedError", {}) {
	override get message() {
		return "git commit failed, often because a commit hook rejected it. Run the commit in a terminal to see why.";
	}
}

export class NoRemoteError extends Schema.TaggedError<NoRemoteError>()("NoRemoteError", {}) {
	override get message() {
		return "This repository has no origin remote. Add one with `git remote add origin <url>`.";
	}
}

export class PushRejectedError extends Schema.TaggedError<PushRejectedError>()("PushRejectedError", {
	branch: Schema.String,
}) {
	override get message() {
		return `The remote rejected the push of ${this.branch} because it has commits you do not. Pull or rebase, then push again.`;
	}
}

export class PushFailedError extends Schema.TaggedError<PushFailedError>()("PushFailedError", {
	branch: Schema.String,
}) {
	override get message() {
		return `Swarm could not push ${this.branch}. Check your network and git credentials, then try again.`;
	}
}

export class GhNotInstalledError extends Schema.TaggedError<GhNotInstalledError>()("GhNotInstalledError", {}) {
	override get message() {
		return "The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then try again.";
	}
}

export class GhNotAuthenticatedError extends Schema.TaggedError<GhNotAuthenticatedError>()(
	"GhNotAuthenticatedError",
	{},
) {
	override get message() {
		return "The GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.";
	}
}

export class PullRequestCreateError extends Schema.TaggedError<PullRequestCreateError>()("PullRequestCreateError", {
	branch: Schema.String,
}) {
	override get message() {
		return `gh could not open a pull request for ${this.branch}. Run \`gh pr create\` in a terminal to see why.`;
	}
}

export class PullRequestReadError extends Schema.TaggedError<PullRequestReadError>()("PullRequestReadError", {
	branch: Schema.String,
}) {
	override get message() {
		return `gh could not read the pull request for ${this.branch}. Run \`gh pr view\` in a terminal to see why.`;
	}
}
