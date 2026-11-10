import {
	BranchAlreadyExistsError,
	Workspace,
	WorkspaceArchivedError,
	WorkspaceHasUnsavedWorkError,
	WorkspaceName,
	WorkspaceNotFoundError,
	WorkspacePathInUseError,
	WorktreeCreateError,
	WorktreeRemoveError,
} from "./Workspace.ts";
import { RunScriptMissingError, ScriptRun, ScriptRunOutput } from "./ScriptRun.ts";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import { ProjectNotFoundError } from "./Project.ts";
import { GitTimeoutError } from "./Git.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";

export const CreateWorkspaceInput = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("worktree"),
		projectId: Schema.String,
		name: WorkspaceName,
	}),
	Schema.Struct({
		kind: Schema.Literal("inPlace"),
		projectId: Schema.String,
	}),
]);
export type CreateWorkspaceInput = typeof CreateWorkspaceInput.Type;

export class WorkspaceRpcs extends RpcGroup.make(
	Rpc.make("createWorkspace", {
		payload: CreateWorkspaceInput,
		success: Workspace,
		error: Schema.Union([
			ProjectNotFoundError,
			WorkspacePathInUseError,
			BranchAlreadyExistsError,
			WorktreeCreateError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("listWorkspaces", {
		payload: { projectId: Schema.String },
		success: Schema.Array(Workspace),
		error: DaemonInternalError,
	}),
	Rpc.make("archiveWorkspace", {
		payload: { workspaceId: Schema.String, force: Schema.Boolean },
		success: Workspace,
		error: Schema.Union([
			WorkspaceNotFoundError,
			WorkspaceHasUnsavedWorkError,
			WorktreeRemoveError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("listScriptRuns", {
		payload: { workspaceId: Schema.String },
		success: Schema.Array(ScriptRun),
		error: DaemonInternalError,
	}),
	Rpc.make("getScriptRunOutput", {
		payload: { scriptRunId: Schema.String },
		success: ScriptRunOutput,
	}),
	// Starts the project's run script in the workspace, or returns the run already going.
	Rpc.make("startRunScript", {
		payload: { workspaceId: Schema.String },
		success: ScriptRun,
		error: Schema.Union([
			WorkspaceNotFoundError,
			WorkspaceArchivedError,
			RunScriptMissingError,
			ProjectNotFoundError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("stopRunScript", {
		payload: { workspaceId: Schema.String },
		error: DaemonInternalError,
	}),
	// The kept output first, then new lines as the script prints them. Ends when the run ends.
	Rpc.make("followScriptRunOutput", {
		payload: { scriptRunId: Schema.String },
		success: Schema.String,
		stream: true,
	}),
) {}
