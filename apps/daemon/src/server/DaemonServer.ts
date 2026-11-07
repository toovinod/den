import { DaemonRpcHandlers } from "../rpc/DaemonRpcHandlers.ts";
import { RpcWebSocketRoute } from "../rpc/RpcWebSocketRoute.ts";
import { Console, Duration, Effect, Layer } from "effect";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { DaemonRpcs } from "@repo/contracts/DaemonRpcs";
import { BunHttpServer } from "@effect/platform-bun";
import { DaemonServices } from "./DaemonServices.ts";
import { HttpRouter, HttpServer } from "effect/http";

// The desktop shell waits for this exact line on stdout to learn the daemon's address.
const READY_LINE_PREFIX = "SWARM_DAEMON_READY ";

const RpcServerLayer = RpcServer.layer(DaemonRpcs).pipe(
	Layer.provide([DaemonRpcHandlers, RpcWebSocketRoute]),
	Layer.provide(RpcSerialization.layerJson),
);

const AnnounceReady = Layer.effectDiscard(
	Effect.gen(function* () {
		const { address } = yield* HttpServer.HttpServer;
		yield* Console.log(`${READY_LINE_PREFIX}${HttpServer.formatAddress(address)}`);
	}),
);

// The only clients are local windows, so on shutdown we drop open WebSockets after a second
// instead of waiting the default 20 seconds for them to close.
const SHUTDOWN_GRACE = Duration.seconds(1);

export const DaemonServer = Layer.unwrap(
	Effect.gen(function* () {
		const { port } = yield* DaemonConfig;
		return Layer.mergeAll(HttpRouter.serve(RpcServerLayer, { disableListenLog: true }), AnnounceReady).pipe(
			Layer.provideMerge(
				BunHttpServer.layer({
					port,
					hostname: "127.0.0.1",
					gracefulShutdownTimeout: SHUTDOWN_GRACE,
				}),
			),
		);
	}),
).pipe(
	// Provided from outside the HTTP server, so it is built before the server and closed after it:
	// on shutdown the server stops taking requests before the services behind them go away.
	Layer.provide(DaemonServices),
);
