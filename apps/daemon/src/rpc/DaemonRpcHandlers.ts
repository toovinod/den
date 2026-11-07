import { DaemonHealth, HealthRpcs } from "@repo/contracts/DaemonRpcs";
import packageJson from "../../package.json" with { type: "json" };
import { WorkspaceRpcHandlers } from "./WorkspaceRpcHandlers.ts";
import { TerminalRpcHandlers } from "./TerminalRpcHandlers.ts";
import { ProjectRpcHandlers } from "./ProjectRpcHandlers.ts";
import { SessionRpcHandlers } from "./SessionRpcHandlers.ts";
import { Effect, Layer } from "effect";

const HealthRpcHandlers = HealthRpcs.toLayer({
	health: () => Effect.succeed(new DaemonHealth({ version: packageJson.version })),
});

export const DaemonRpcHandlers = Layer.mergeAll(
	HealthRpcHandlers,
	ProjectRpcHandlers,
	WorkspaceRpcHandlers,
	SessionRpcHandlers,
	TerminalRpcHandlers,
);
