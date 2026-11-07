import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { WorkspaceArchivedError } from "@repo/contracts/Workspace";
import { TerminalService } from "../terminals/TerminalService.ts";
import { TerminalRpcs } from "@repo/contracts/TerminalRpcs";
import { orInternalError } from "./orInternalError.ts";
import { Effect } from "effect";

export const TerminalRpcHandlers = TerminalRpcs.toLayer(
	Effect.gen(function* () {
		const terminals = yield* TerminalService;
		const workspaces = yield* WorkspaceService;
		return TerminalRpcs.of({
			openTerminal: ({ workspaceId, cols, rows }) =>
				Effect.gen(function* () {
					const current = yield* workspaces.get(workspaceId);
					if (current.status === "archived") {
						return yield* new WorkspaceArchivedError({ workspaceId });
					}
					return yield* terminals.open(workspaceId, current.path, { cols, rows });
				}).pipe(orInternalError("open a terminal")),
			listTerminals: ({ workspaceId }) => Effect.succeed(terminals.list(workspaceId)),
			attachTerminal: ({ terminalId }) => terminals.attach(terminalId),
			writeTerminal: ({ terminalId, data }) => terminals.write(terminalId, data),
			resizeTerminal: ({ terminalId, cols, rows }) => terminals.resize(terminalId, { cols, rows }),
			closeTerminal: ({ terminalId }) => terminals.close(terminalId),
		});
	}),
);
