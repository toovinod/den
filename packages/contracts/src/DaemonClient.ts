import { RpcClient, type RpcClientError, type RpcGroup, RpcSerialization } from "effect/rpc";
import { DaemonRpcs } from "./DaemonRpcs.ts";
import { Context, Layer } from "effect";
import { Socket } from "effect/socket";

export class DaemonClient extends Context.Service<
	DaemonClient,
	RpcClient.RpcClient<RpcGroup.Rpcs<typeof DaemonRpcs>, RpcClientError.RpcClientError>
>()("swarm/contracts/DaemonClient") {
	static readonly layer = (webSocketUrl: string) =>
		Layer.effect(DaemonClient, RpcClient.make(DaemonRpcs)).pipe(
			Layer.provide(RpcClient.layerProtocolSocket()),
			Layer.provide(Socket.layerWebSocket(webSocketUrl)),
			Layer.provide(Socket.layerWebSocketConstructorGlobal),
			Layer.provide(RpcSerialization.layerJson),
		);
}
