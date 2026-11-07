import { FileContent, FileEntry, FileNotFoundError, FileReadError } from "./WorkspaceFile.ts";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import { WorkspaceNotFoundError } from "./Workspace.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";

export class FileRpcs extends RpcGroup.make(
	// The direct children of a folder, skipping what .gitignore ignores. "" is the workspace root.
	Rpc.make("listDirectory", {
		payload: { workspaceId: Schema.String, path: Schema.String },
		success: Schema.Array(FileEntry),
		error: Schema.Union([WorkspaceNotFoundError, DaemonInternalError]),
	}),
	Rpc.make("readFile", {
		payload: { workspaceId: Schema.String, path: Schema.String },
		success: FileContent,
		error: Schema.Union([WorkspaceNotFoundError, FileNotFoundError, FileReadError, DaemonInternalError]),
	}),
) {}
