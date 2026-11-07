import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export class DaemonHealth extends Schema.Class<DaemonHealth>("DaemonHealth")({
	version: Schema.String,
}) {}

export class DaemonRpcs extends RpcGroup.make(
	Rpc.make("health", { success: DaemonHealth }),
) {}
