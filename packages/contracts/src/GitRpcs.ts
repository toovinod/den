import {
	CommitFailedError,
	CommitResult,
	DiffFile,
	GhNotAuthenticatedError,
	GhNotInstalledError,
	GitStatus,
	NoRemoteError,
	NothingToCommitError,
	PullRequestCreateError,
	PullRequestReadError,
	PullRequestStatus,
	PushFailedError,
	PushRejectedError,
	WorkspaceDiff,
} from "./Git.ts";
import { Workspace, WorkspaceNotFoundError } from "./Workspace.ts";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import { FileReadError } from "./WorkspaceFile.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";

const PushError = [NoRemoteError, PushRejectedError, PushFailedError] as const;
const GhError = [GhNotInstalledError, GhNotAuthenticatedError] as const;

export class GitRpcs extends RpcGroup.make(
	Rpc.make("getWorkspaceDiff", {
		payload: { workspaceId: Schema.String },
		success: WorkspaceDiff,
		error: Schema.Union([WorkspaceNotFoundError, FileReadError, DaemonInternalError]),
	}),
	// One file in full, for a file the workspace diff left out as too large.
	Rpc.make("getFileDiff", {
		payload: { workspaceId: Schema.String, path: Schema.String },
		success: Schema.NullOr(DiffFile),
		error: Schema.Union([WorkspaceNotFoundError, FileReadError, DaemonInternalError]),
	}),
	Rpc.make("getGitStatus", {
		payload: { workspaceId: Schema.String },
		success: GitStatus,
		error: Schema.Union([WorkspaceNotFoundError, DaemonInternalError]),
	}),
	// paths null commits every change, untracked files included.
	Rpc.make("commit", {
		payload: {
			workspaceId: Schema.String,
			message: Schema.NonEmptyString,
			paths: Schema.NullOr(Schema.Array(Schema.String)),
		},
		success: CommitResult,
		error: Schema.Union([WorkspaceNotFoundError, NothingToCommitError, CommitFailedError, DaemonInternalError]),
	}),
	Rpc.make("push", {
		payload: { workspaceId: Schema.String },
		error: Schema.Union([WorkspaceNotFoundError, ...PushError, DaemonInternalError]),
	}),
	// Pushes the branch first, then stores the pull request URL on the workspace.
	Rpc.make("createPullRequest", {
		payload: {
			workspaceId: Schema.String,
			title: Schema.NonEmptyString,
			body: Schema.String,
			draft: Schema.Boolean,
		},
		success: Workspace,
		error: Schema.Union([
			WorkspaceNotFoundError,
			...PushError,
			...GhError,
			PullRequestCreateError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("getPullRequest", {
		payload: { workspaceId: Schema.String },
		success: PullRequestStatus,
		error: Schema.Union([WorkspaceNotFoundError, ...GhError, PullRequestReadError, DaemonInternalError]),
	}),
) {}
