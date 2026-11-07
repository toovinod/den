import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import { ProjectNotFoundError } from "./Project.ts";
import { ScriptRun, ScriptRunOutput } from "./ScriptRun.ts";
import {
	BranchAlreadyExistsError,
	Workspace,
	WorkspaceHasUnsavedWorkError,
	WorkspaceName,
	WorkspaceNotFoundError,
	WorkspacePathInUseError,
	WorktreeCreateError,
	WorktreeRemoveError,
} from "./Workspace.ts";

export const CreateWorkspaceInput = Schema.Union([
	// A new branch and folder under the data dir. The setup script runs there.
	Schema.Struct({
		kind: Schema.Literal("worktree"),
		projectId: Schema.String,
		name: WorkspaceName,
	}),
	// The project folder itself, on whatever branch it has checked out.
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
) {}
