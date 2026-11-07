import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import { LocalDatabase } from "../database/LocalDatabase.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";

// The services behind the RPC handlers. Opening the database runs pending migrations,
// and starting WorkspaceService recovers setup scripts cut off by a restart.
export const DaemonServices = WorkspaceService.layer.pipe(
	Layer.provideMerge(ProjectService.layer),
	Layer.provideMerge(LocalDatabase.layer),
	Layer.provide([BunServices.layer, SecureRandom.layerWebCrypto]),
);
