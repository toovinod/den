import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { DaemonClient } from "@repo/contracts/DaemonClient";
import { Effect, FileSystem, Layer } from "effect";
import { HttpServer } from "effect/http";
import packageJson from "../../package.json" with { type: "json" };
import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { TEST_TOKEN, testDaemonConfig } from "../testing/testDaemonConfig.ts";
import { DaemonServer } from "./DaemonServer.ts";

// Starts a daemon with its data dir in a fresh temp folder, which is removed afterwards.
const runWithDaemon = <A, E>(
	program: (
		baseUrl: string,
		tempDir: string,
	) => Effect.Effect<A, E, BunServices.BunServices>,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tempDir = yield* fs.makeTempDirectoryScoped();
		return yield* Effect.gen(function* () {
			const { address } = yield* HttpServer.HttpServer;
			return yield* program(HttpServer.formatAddress(address), tempDir);
		}).pipe(
			Effect.provide(
				DaemonServer.pipe(
					Layer.provide(testDaemonConfig(join(tempDir, "data"))),
				),
			),
		);
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

const withClient = (baseUrl: string) =>
	Effect.provide(
		DaemonClient.layer(
			`${baseUrl.replace("http", "ws")}/rpc?token=${TEST_TOKEN}`,
		),
	);

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
		expect(result.projects.map((project) => project.id)).toEqual([
			result.added.id,
		]);
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
});
