import { WorkspaceRpcs } from "@repo/contracts/WorkspaceRpcs";
import { Effect } from "effect";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { orInternalError } from "./orInternalError.ts";

export const WorkspaceRpcHandlers = WorkspaceRpcs.toLayer(
	Effect.gen(function* () {
		const workspaces = yield* WorkspaceService;
		return WorkspaceRpcs.of({
			createWorkspace: (input) =>
				workspaces.create(input).pipe(orInternalError("create the workspace")),
			listWorkspaces: ({ projectId }) =>
				workspaces.list(projectId).pipe(orInternalError("list workspaces")),
			archiveWorkspace: ({ workspaceId, force }) =>
				workspaces
					.archive(workspaceId, { force })
					.pipe(orInternalError("archive the workspace")),
			listScriptRuns: ({ workspaceId }) =>
				workspaces
					.listScriptRuns(workspaceId)
					.pipe(orInternalError("list script runs")),
			getScriptRunOutput: ({ scriptRunId }) =>
				Effect.succeed(workspaces.getScriptRunOutput(scriptRunId)),
		});
	}),
);
