import { TEST_TOKEN, testDaemonConfig } from "../testing/testDaemonConfig.ts";
import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { testAgentServices } from "../testing/testAgentServices.ts";
import packageJson from "../../package.json" with { type: "json" };
import { DaemonClient } from "@repo/contracts/DaemonClient";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { DaemonServer } from "./DaemonServer.ts";
import { HttpServer } from "effect/http";
import { join } from "node:path";

const runWithDaemon = <A, E>(
	program: (baseUrl: string, tempDir: string) => Effect.Effect<A, E, BunServices.BunServices>,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tempDir = yield* fs.makeTempDirectoryScoped();
		return yield* Effect.gen(function* () {
			const { address } = yield* HttpServer.HttpServer;
			return yield* program(HttpServer.formatAddress(address), tempDir);
		}).pipe(
			Effect.provide(DaemonServer.pipe(Layer.provide([testDaemonConfig(join(tempDir, "data")), testAgentServices()]))),
		);
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

const withClient = (baseUrl: string) =>
	Effect.provide(DaemonClient.layer(`${baseUrl.replace("http", "ws")}/rpc?token=${TEST_TOKEN}`));

const statusOf = (url: string) => Effect.promise(() => fetch(url).then((response) => response.status));

describe("DaemonServer", () => {
	test("rejects connections without the right token", async () => {
		const statuses = await runWithDaemon((baseUrl) =>
			Effect.all([statusOf(`${baseUrl}/rpc`), statusOf(`${baseUrl}/rpc?token=wrong`)]),
		);
		expect(statuses).toEqual([401, 401]);
	});

	test("answers health over a WebSocket with the right token", async () => {
		const health = await runWithDaemon((baseUrl) =>
			Effect.gen(function* () {
				const client = yield* DaemonClient;
				return yield* client.health();
			}).pipe(withClient(baseUrl)),
		);
		expect(health.version).toBe(packageJson.version);
	});

	test("adds a project and an in-place workspace over RPC", async () => {
		const result = await runWithDaemon((baseUrl, tempDir) =>
			Effect.gen(function* () {
				const repositoryPath = yield* makeTestRepository(join(tempDir, "repo"));
				const client = yield* DaemonClient;
				const added = yield* client.addProject({ path: repositoryPath });
				const projects = yield* client.listProjects();
				const workspace = yield* client.createWorkspace({
					kind: "inPlace",
					projectId: added.id,
				});
				const workspaces = yield* client.listWorkspaces({
					projectId: added.id,
				});
				return { added, projects, workspace, workspaces };
			}).pipe(withClient(baseUrl)),
		);
		expect(result.added.name).toBe("repo");
		expect(result.added.defaultBranch).toBe("main");
		expect(result.projects.map((project) => project.id)).toEqual([result.added.id]);
		expect(result.workspace.kind).toBe("inPlace");
		expect(result.workspace.branch).toBe("main");
		expect(result.workspaces).toEqual([result.workspace]);
	});

	test("returns a tagged error with a user-facing message over RPC", async () => {
		const error = await runWithDaemon((baseUrl, tempDir) =>
			Effect.gen(function* () {
				const client = yield* DaemonClient;
				return yield* Effect.flip(client.addProject({ path: tempDir }));
			}).pipe(withClient(baseUrl)),
		);
		expect(error._tag).toBe("NotAGitRepositoryError");
		expect(error.message).toContain("is not a git repository");
	});

	test("runs a session turn with an approval over RPC", async () => {
		const result = await runWithDaemon((baseUrl, tempDir) =>
			Effect.gen(function* () {
				const repositoryPath = yield* makeTestRepository(join(tempDir, "repo"));
				const client = yield* DaemonClient;
				const project = yield* client.addProject({ path: repositoryPath });
				const workspace = yield* client.createWorkspace({ kind: "inPlace", projectId: project.id });
				const session = yield* client.createSession({
					workspaceId: workspace.id,
					agent: "codex",
					model: "replay",
					effort: null,
				});
				const eventsUntil = (afterSequence: number, type: string) =>
					client.subscribeSession({ sessionId: session.id, afterSequence }).pipe(
						Stream.takeUntil((stored) => stored.event.type === type),
						Stream.runCollect,
					);
				yield* client.sendMessage({ sessionId: session.id, text: "run the tests", images: [], steer: false });
				const beforeApproval = yield* eventsUntil(-1, "approval.requested");
				yield* client.respondToApproval({ sessionId: session.id, requestId: "0", decision: "allowOnce" });
				const afterApproval = yield* eventsUntil(beforeApproval.at(-1)?.sequence ?? -1, "turn.completed");
				const [listed] = yield* client.listSessions({ workspaceId: workspace.id });
				return { events: [...beforeApproval, ...afterApproval], listed };
			}).pipe(withClient(baseUrl)),
		);
		expect(
			result.events.filter((stored) => stored.sequence !== null).map((stored) => [stored.sequence, stored.event.type]),
		).toEqual([
			[0, "session.started"],
			[1, "user.message"],
			[2, "message.completed"],
			[3, "tool.started"],
			[4, "approval.requested"],
			[5, "approval.resolved"],
			[6, "tool.completed"],
			[7, "turn.completed"],
		]);
		expect(result.listed).toMatchObject({ agent: "codex", nativeSessionId: "thread-replay" });
	});
});
