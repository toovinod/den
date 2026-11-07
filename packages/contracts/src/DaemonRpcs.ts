import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ProjectRpcs } from "./ProjectRpcs.ts";
import { WorkspaceRpcs } from "./WorkspaceRpcs.ts";

export class DaemonHealth extends Schema.Class<DaemonHealth>("DaemonHealth")({
	version: Schema.String,
}) {}

export class HealthRpcs extends RpcGroup.make(Rpc.make("health", { success: DaemonHealth })) {}

export const DaemonRpcs = HealthRpcs.merge(ProjectRpcs, WorkspaceRpcs);
