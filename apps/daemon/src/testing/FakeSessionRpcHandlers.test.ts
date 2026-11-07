import { FakeSessionRpcHandlers } from "./FakeSessionRpcHandlers.ts";
import { TEST_TOKEN, testDaemonConfig } from "./testDaemonConfig.ts";
import { CoreRpcHandlers } from "../rpc/DaemonRpcHandlers.ts";
import { makeDaemonServer } from "../server/DaemonServer.ts";
import { makeTestRepository } from "./makeTestRepository.ts";
import { DaemonClient } from "@repo/contracts/DaemonClient";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { HttpServer } from "effect/http";
import { join } from "node:path";

describe("FakeSessionRpcHandlers", () => {
	test("replays a turn that waits for an approval, and replays history to a late subscriber", async () => {
		const result = await Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tempDir = yield* fs.makeTempDirectoryScoped();
			const server = makeDaemonServer(Layer.merge(CoreRpcHandlers, FakeSessionRpcHandlers)).pipe(
				Layer.provide(testDaemonConfig(join(tempDir, "data"))),
			);
			return yield* Effect.gen(function* () {
				const { address } = yield* HttpServer.HttpServer;
				const url = `${HttpServer.formatAddress(address).replace("http", "ws")}/rpc?token=${TEST_TOKEN}`;
				return yield* Effect.gen(function* () {
					const client = yield* DaemonClient;
					const project = yield* client.addProject({ path: yield* makeTestRepository(join(tempDir, "repo")) });
					const workspace = yield* client.createWorkspace({ kind: "inPlace", projectId: project.id });
					const session = yield* client.createSession({
						workspaceId: workspace.id,
						agent: "codex",
						model: "gpt-codex",
						effort: null,
					});
					yield* client.sendMessage({ sessionId: session.id, text: "Run the tests", images: [], steer: false });
					const untilApproval = yield* client.subscribeSession({ sessionId: session.id, afterSequence: -1 }).pipe(
						Stream.takeUntil((item) => item.event.type === "approval.requested"),
						Stream.runCollect,
					);
					const approval = untilApproval.at(-1)?.event;
					if (approval?.type !== "approval.requested") {
						return yield* Effect.die("no approval was requested");
					}
					yield* client.respondToApproval({
						sessionId: session.id,
						requestId: approval.requestId,
						decision: "allowOnce",
					});
					const rest = yield* client.subscribeSession({ sessionId: session.id, afterSequence: -1 }).pipe(
						Stream.takeUntil((item) => item.event.type === "turn.completed"),
						Stream.runCollect,
					);
					const [after] = yield* client.listSessions({ workspaceId: workspace.id });
					return { untilApproval, rest, status: after?.status };
				}).pipe(Effect.provide(DaemonClient.layer(url)));
			}).pipe(Effect.provide(server));
		}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

		expect(result.untilApproval[0]?.event).toMatchObject({ type: "user.message", text: "Run the tests" });
		const stored = result.rest.filter((item) => item.sequence !== null);
		expect(stored.map((item) => item.sequence)).toEqual(stored.map((_, index) => index));
		expect(stored.map((item) => item.event.type)).toContain("approval.resolved");
		expect(result.rest.at(-1)?.event).toMatchObject({ type: "turn.completed", result: { status: "completed" } });
		expect(result.status).toBe("idle");
	}, 15_000);
});
