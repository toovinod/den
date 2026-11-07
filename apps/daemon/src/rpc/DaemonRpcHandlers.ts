import { DaemonHealth, HealthRpcs } from "@repo/contracts/DaemonRpcs";
import packageJson from "../../package.json" with { type: "json" };
import { WorkspaceRpcHandlers } from "./WorkspaceRpcHandlers.ts";
import { ProjectRpcHandlers } from "./ProjectRpcHandlers.ts";
import { Effect, Layer } from "effect";

const HealthRpcHandlers = HealthRpcs.toLayer({
	health: () => Effect.succeed(new DaemonHealth({ version: packageJson.version })),
});

export const DaemonRpcHandlers = Layer.mergeAll(HealthRpcHandlers, ProjectRpcHandlers, WorkspaceRpcHandlers);
