import { DaemonHealth, HealthRpcs } from "@repo/contracts/DaemonRpcs";
import { Effect, Layer } from "effect";
import packageJson from "../../package.json" with { type: "json" };
import { ProjectRpcHandlers } from "./ProjectRpcHandlers.ts";
import { WorkspaceRpcHandlers } from "./WorkspaceRpcHandlers.ts";

const HealthRpcHandlers = HealthRpcs.toLayer({
	health: () =>
		Effect.succeed(new DaemonHealth({ version: packageJson.version })),
});

export const DaemonRpcHandlers = Layer.mergeAll(
	HealthRpcHandlers,
	ProjectRpcHandlers,
	WorkspaceRpcHandlers,
);
