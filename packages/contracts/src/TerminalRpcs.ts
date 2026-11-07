import { TerminalInfo, TerminalNotFoundError, TerminalOutput, TerminalSize, TerminalSpawnError } from "./Terminal.ts";
import { WorkspaceArchivedError, WorkspaceNotFoundError } from "./Workspace.ts";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";

// Terminals live in the daemon's memory only. They close when their workspace is archived or the daemon stops.
export class TerminalRpcs extends RpcGroup.make(
	Rpc.make("openTerminal", {
		payload: { workspaceId: Schema.String, ...TerminalSize },
		success: TerminalInfo,
		error: Schema.Union([WorkspaceNotFoundError, WorkspaceArchivedError, TerminalSpawnError, DaemonInternalError]),
	}),
	Rpc.make("listTerminals", {
		payload: { workspaceId: Schema.String },
		success: Schema.Array(TerminalInfo),
	}),
	Rpc.make("attachTerminal", {
		payload: { terminalId: Schema.String },
		success: TerminalOutput,
		error: TerminalNotFoundError,
		stream: true,
	}),
	Rpc.make("writeTerminal", {
		payload: { terminalId: Schema.String, data: Schema.String },
		error: TerminalNotFoundError,
	}),
	Rpc.make("resizeTerminal", {
		payload: { terminalId: Schema.String, ...TerminalSize },
		error: TerminalNotFoundError,
	}),
	Rpc.make("closeTerminal", {
		payload: { terminalId: Schema.String },
	}),
) {}
