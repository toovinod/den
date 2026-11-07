import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import {
	DefaultBranchNotFoundError,
	NotAGitRepositoryError,
	Project,
	ProjectAlreadyAddedError,
	ProjectFolderNotFoundError,
	ProjectHasActiveWorkspacesError,
	ProjectNotFoundError,
} from "./Project.ts";

export class ProjectRpcs extends RpcGroup.make(
	Rpc.make("addProject", {
		payload: { path: Schema.String },
		success: Project,
		error: Schema.Union([
			ProjectFolderNotFoundError,
			NotAGitRepositoryError,
			DefaultBranchNotFoundError,
			ProjectAlreadyAddedError,
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
) {}
