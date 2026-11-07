import { WorkspaceRpcs } from "./WorkspaceRpcs.ts";
import { ProjectRpcs } from "./ProjectRpcs.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";

export class DaemonHealth extends Schema.Class<DaemonHealth>("DaemonHealth")({
	version: Schema.String,
}) {}

export class HealthRpcs extends RpcGroup.make(Rpc.make("health", { success: DaemonHealth })) {}

export const DaemonRpcs = HealthRpcs.merge(ProjectRpcs, WorkspaceRpcs);
