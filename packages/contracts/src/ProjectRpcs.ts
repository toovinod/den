import {
	DefaultBranchNotFoundError,
	NotAGitRepositoryError,
	Project,
	ProjectAlreadyAddedError,
	ProjectCreateError,
	ProjectFolderExistsError,
	ProjectFolderName,
	ProjectFolderNotFoundError,
	ProjectHasActiveWorkspacesError,
	ProjectNotFoundError,
} from "./Project.ts";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import { GitTimeoutError } from "./Git.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";

export class ProjectRpcs extends RpcGroup.make(
	Rpc.make("addProject", {
		payload: { path: Schema.String },
		success: Project,
		error: Schema.Union([
			ProjectFolderNotFoundError,
			NotAGitRepositoryError,
			DefaultBranchNotFoundError,
			ProjectAlreadyAddedError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	// Makes a new folder in parentPath, initializes a repository with an empty first commit, and adds it.
	Rpc.make("createProject", {
		payload: { parentPath: Schema.String, name: ProjectFolderName },
		success: Project,
		error: Schema.Union([
			ProjectFolderNotFoundError,
			ProjectFolderExistsError,
			ProjectCreateError,
			NotAGitRepositoryError,
			DefaultBranchNotFoundError,
			ProjectAlreadyAddedError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("listProjects", {
		success: Schema.Array(Project),
		error: DaemonInternalError,
	}),
	Rpc.make("removeProject", {
		payload: { projectId: Schema.String },
		error: Schema.Union([ProjectNotFoundError, ProjectHasActiveWorkspacesError, DaemonInternalError]),
	}),
	Rpc.make("updateProjectScripts", {
		payload: {
			projectId: Schema.String,
			setupScript: Schema.NullOr(Schema.String),
			runScript: Schema.NullOr(Schema.String),
		},
		success: Project,
		error: Schema.Union([ProjectNotFoundError, DaemonInternalError]),
	}),
	Rpc.make("setProjectTrust", {
		payload: { projectId: Schema.String, trusted: Schema.Boolean },
		success: Project,
		error: Schema.Union([ProjectNotFoundError, DaemonInternalError]),
	}),
) {}
