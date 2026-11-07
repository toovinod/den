import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { TerminalService } from "../terminals/TerminalService.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { LocalDatabase } from "../database/LocalDatabase.ts";
import { BunServices } from "@effect/platform-bun";
import { SecureRandom } from "effect/crypto";
import { Layer } from "effect";

// The services behind the RPC handlers. Opening the database runs pending migrations,
// and starting WorkspaceService recovers setup scripts cut off by a restart.
export const DaemonServices = WorkspaceService.layer.pipe(
	Layer.provideMerge(TerminalService.layer),
	Layer.provideMerge(ProjectService.layer),
	Layer.provideMerge(LocalDatabase.layer),
	Layer.provide([BunServices.layer, SecureRandom.layerWebCrypto]),
);
