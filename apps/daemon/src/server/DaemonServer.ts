import { BunHttpServer } from "@effect/platform-bun";
import { DaemonRpcs } from "@repo/contracts/DaemonRpcs";
import { Console, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { DaemonRpcHandlers } from "../rpc/DaemonRpcHandlers.ts";
import { RpcWebSocketRoute } from "../rpc/RpcWebSocketRoute.ts";

// The desktop shell waits for this exact line on stdout to learn the daemon's address.
export const READY_LINE_PREFIX = "SWARM_DAEMON_READY ";

const RpcServerLayer = RpcServer.layer(DaemonRpcs).pipe(
	Layer.provide([DaemonRpcHandlers, RpcWebSocketRoute]),
	Layer.provide(RpcSerialization.layerJson),
);

const AnnounceReady = Layer.effectDiscard(
	Effect.gen(function* () {
		const { address } = yield* HttpServer.HttpServer;
		yield* Console.log(
			`${READY_LINE_PREFIX}${HttpServer.formatAddress(address)}`,
		);
	}),
);

export const DaemonServer = Layer.unwrap(
	Effect.gen(function* () {
		const { port } = yield* DaemonConfig;
		return Layer.mergeAll(
			HttpRouter.serve(RpcServerLayer, { disableListenLog: true }),
			AnnounceReady,
		).pipe(
			Layer.provideMerge(BunHttpServer.layer({ port, hostname: "127.0.0.1" })),
		);
	}),
);
