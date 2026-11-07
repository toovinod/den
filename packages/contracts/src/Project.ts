import { Schema } from "effect";

export class Project extends Schema.Class<Project>("Project")({
	id: Schema.String,
	name: Schema.String,
	path: Schema.String,
	defaultBranch: Schema.String,
	setupScript: Schema.NullOr(Schema.String),
	runScript: Schema.NullOr(Schema.String),
	trusted: Schema.Boolean,
	createdAt: Schema.String,
}) {}

export class ProjectFolderNotFoundError extends Schema.TaggedError<ProjectFolderNotFoundError>()(
	"ProjectFolderNotFoundError",
	{ path: Schema.String },
) {
	override get message() {
		return `The folder ${this.path} does not exist. Pick an existing folder.`;
	}
}

export class NotAGitRepositoryError extends Schema.TaggedError<NotAGitRepositoryError>()("NotAGitRepositoryError", {
	path: Schema.String,
}) {
	override get message() {
		return `${this.path} is not a git repository. Run \`git init\` there or pick a folder inside a repository.`;
	}
}

export class DefaultBranchNotFoundError extends Schema.TaggedError<DefaultBranchNotFoundError>()(
	"DefaultBranchNotFoundError",
	{ path: Schema.String },
) {
	override get message() {
		return `Swarm could not find a default branch for ${this.path}. Check out a branch or set origin/HEAD, then add the project again.`;
	}
}

export class ProjectAlreadyAddedError extends Schema.TaggedError<ProjectAlreadyAddedError>()(
	"ProjectAlreadyAddedError",
	{ path: Schema.String },
) {
	override get message() {
		return `${this.path} is already a project in Swarm.`;
	}
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()("ProjectNotFoundError", {
	projectId: Schema.String,
}) {
	override get message() {
		return "This project no longer exists. Refresh the project list.";
	}
}

export class ProjectHasActiveWorkspacesError extends Schema.TaggedError<ProjectHasActiveWorkspacesError>()(
	"ProjectHasActiveWorkspacesError",
	{ projectId: Schema.String, activeWorkspaces: Schema.Int },
) {
	override get message() {
		return `This project has ${this.activeWorkspaces} active workspace(s). Archive them before removing the project.`;
	}
}
