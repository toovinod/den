import { Schema } from "effect";

export const WorkspaceKind = Schema.Literals(["worktree", "inPlace"]);
export type WorkspaceKind = typeof WorkspaceKind.Type;

// Runtime activity (agents or scripts running) is derived, never stored here.
export const WorkspaceStatus = Schema.Literals(["active", "archived"]);
export type WorkspaceStatus = typeof WorkspaceStatus.Type;

// The name becomes the git branch and the worktree folder, so keep it to safe characters.
export const WorkspaceName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/));

export class Workspace extends Schema.Class<Workspace>("Workspace")({
	id: Schema.String,
	projectId: Schema.String,
	name: Schema.String,
	kind: WorkspaceKind,
	path: Schema.String,
	branch: Schema.String,
	baseBranch: Schema.String,
	status: WorkspaceStatus,
	pullRequestUrl: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	archivedAt: Schema.NullOr(Schema.String),
}) {}

export class WorkspaceNotFoundError extends Schema.TaggedError<WorkspaceNotFoundError>()("WorkspaceNotFoundError", {
	workspaceId: Schema.String,
}) {
	override get message() {
		return "This workspace no longer exists. Refresh the workspace list.";
	}
}

export class WorkspacePathInUseError extends Schema.TaggedError<WorkspacePathInUseError>()("WorkspacePathInUseError", {
	path: Schema.String,
}) {
	override get message() {
		return `An active workspace already uses ${this.path}. Archive it first or pick another name.`;
	}
}

export class BranchAlreadyExistsError extends Schema.TaggedError<BranchAlreadyExistsError>()(
	"BranchAlreadyExistsError",
	{ branch: Schema.String },
) {
	override get message() {
		return `The branch ${this.branch} already exists. Pick another workspace name.`;
	}
}

export class WorktreeCreateError extends Schema.TaggedError<WorktreeCreateError>()("WorktreeCreateError", {
	branch: Schema.String,
}) {
	override get message() {
		return `Swarm could not create a worktree for ${this.branch}. Check that the base branch exists and the repository is not locked.`;
	}
}

export class WorktreeRemoveError extends Schema.TaggedError<WorktreeRemoveError>()("WorktreeRemoveError", {
	path: Schema.String,
}) {
	override get message() {
		return `Swarm could not remove the worktree at ${this.path}. Close programs using it and try again.`;
	}
}

export class WorkspaceHasUnsavedWorkError extends Schema.TaggedError<WorkspaceHasUnsavedWorkError>()(
	"WorkspaceHasUnsavedWorkError",
	{
		workspaceId: Schema.String,
		changedFiles: Schema.Array(Schema.String),
		unpushedCommits: Schema.Int,
	},
) {
	override get message() {
		return `This workspace has ${this.changedFiles.length} changed file(s) and ${this.unpushedCommits} unpushed commit(s). Commit and push them, or archive with force to stash the changes and keep the branch.`;
	}
}

export class WorkspaceArchivedError extends Schema.TaggedError<WorkspaceArchivedError>()("WorkspaceArchivedError", {
	workspaceId: Schema.String,
}) {
	override get message() {
		return "This workspace is archived, so its agents cannot run. Start a new workspace to keep working.";
	}
}
