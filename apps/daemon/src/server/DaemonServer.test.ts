import { describe, expect, test } from "bun:test";
import { DaemonClient } from "@repo/contracts/DaemonClient";
import { Effect, Layer, Redacted } from "effect";
import { HttpServer } from "effect/http";
import packageJson from "../../package.json" with { type: "json" };
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { DaemonServer } from "./DaemonServer.ts";

const TOKEN = "test-token";

const TestDaemon = DaemonServer.pipe(
	Layer.provide(
		Layer.succeed(
			DaemonConfig,
			DaemonConfig.of({ port: 0, token: Redacted.make(TOKEN) }),
		),
	),
);

const runWithDaemon = <A, E>(
	program: (baseUrl: string) => Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		const { address } = yield* HttpServer.HttpServer;
		return yield* program(HttpServer.formatAddress(address));
	}).pipe(Effect.provide(TestDaemon), Effect.scoped, Effect.runPromise);

const statusOf = (url: string) =>
	Effect.promise(() => fetch(url).then((response) => response.status));

describe("DaemonServer", () => {
	test("rejects connections without the right token", async () => {
		const statuses = await runWithDaemon((baseUrl) =>
			Effect.all([
				statusOf(`${baseUrl}/rpc`),
				statusOf(`${baseUrl}/rpc?token=wrong`),
			]),
		);
		expect(statuses).toEqual([401, 401]);
	});

	test("answers health over a WebSocket with the right token", async () => {
		const health = await runWithDaemon((baseUrl) =>
			Effect.gen(function* () {
				const client = yield* DaemonClient;
				return yield* client.health();
			}).pipe(
				Effect.provide(
					DaemonClient.layer(
						`${baseUrl.replace("http", "ws")}/rpc?token=${TOKEN}`,
					),
				),
			),
		);
		expect(health.version).toBe(packageJson.version);
	});
});
