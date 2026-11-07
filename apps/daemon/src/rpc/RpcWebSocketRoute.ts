import { timingSafeEqual } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcServer } from "effect/rpc";
import { DaemonConfig } from "../config/DaemonConfig.ts";

const RpcConnectionParams = Schema.Struct({ token: Schema.String });

const unauthorized = HttpServerResponse.empty({ status: 401 });

// Constant-time comparison so the token cannot be guessed from response timing.
const isDaemonToken = (candidate: string, expected: Redacted.Redacted<string>) => {
	const candidateBytes = Buffer.from(candidate);
	const expectedBytes = Buffer.from(Redacted.value(expected));
	return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
};

// Browsers cannot set headers on a WebSocket, so the token travels as `?token=`.
export const RpcWebSocketRoute = Layer.effect(
	RpcServer.Protocol,
	Effect.gen(function* () {
		const { token } = yield* DaemonConfig;
		const router = yield* HttpRouter.HttpRouter;
		const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;

		yield* router.add(
			"GET",
			"/rpc",
			Effect.gen(function* () {
				const params = yield* HttpServerRequest.schemaSearchParams(RpcConnectionParams);
				if (!isDaemonToken(params.token, token)) {
					return unauthorized;
				}
				return yield* httpEffect;
			}).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(unauthorized))),
		);

		return protocol;
	}),
);
