import { runInTempDir, runServiceTest, type Services, withServices } from "../testing/runServiceTest.ts";
import { Deferred, Effect, Fiber, FileSystem, Logger, Redacted, Schedule, Stream } from "effect";
import { commandWithApproval, testAgentServices } from "../testing/testAgentServices.ts";
import { makeReplayAdapter, type Recording } from "../agents/replay/ReplayAdapter.ts";
import type { AgentSessionStatus, AgentKind } from "@repo/contracts/AgentSession";
import { DATABASE_FILE_NAME, LocalDatabase } from "../database/LocalDatabase.ts";
import type { AgentAdapter, StartSessionInput } from "../agents/AgentAdapter.ts";
import { MAX_RUNNING_SESSIONS, SessionService } from "./SessionService.ts";
import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { agentSession, sessionEvent } from "../database/schema.ts";
import type { SessionEvent } from "@repo/contracts/SessionEvent";
import { ProjectService } from "../projects/ProjectService.ts";
import type { AgentEvent } from "@repo/contracts/AgentEvent";
import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { join } from "node:path";

const addWorkspace = Effect.fn("addWorkspace")(function* (tempDir: string) {
	const path = yield* makeTestRepository(join(tempDir, "repo"));
	const project = yield* Effect.flatMap(ProjectService, (projects) => projects.add(path));
	return yield* Effect.flatMap(WorkspaceService, (workspaces) =>
		workspaces.create({ kind: "inPlace", projectId: project.id }),
	);
});

const addSession = Effect.fn("addSession")(function* (tempDir: string, agent: AgentKind = "codex") {
	const workspace = yield* addWorkspace(tempDir);
	const sessions = yield* SessionService;
	return yield* sessions.create({ workspaceId: workspace.id, agent, model: "replay" });
});

const statusOf = (sessionId: string) =>
	Effect.flatMap(LocalDatabase, (database) =>
		database.query((db) => db.select().from(agentSession).where(eq(agentSession.id, sessionId))),
	).pipe(Effect.map(([row]) => row?.status));

const waitForStatus = (sessionId: string, status: AgentSessionStatus) =>
	statusOf(sessionId).pipe(
		Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (current) => current === status }),
		Effect.timeout("5 seconds"),
	);

const eventsUntil = (sessionId: string, afterSequence: number, type: AgentEvent["type"]) =>
	Effect.flatMap(SessionService, (sessions) =>
		sessions.subscribe(sessionId, afterSequence).pipe(
			Stream.takeUntil((stored) => stored.event.type === type),
			Stream.runCollect,
		),
	).pipe(Effect.timeout("5 seconds"));

const storedEvents = (sessionId: string) =>
	Effect.flatMap(LocalDatabase, (database) =>
		database.query((db) =>
			db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, sessionId)).orderBy(asc(sessionEvent.sequence)),
		),
	);

// A fresh session is already idle, so a finished turn is detected by its stored events instead.
const waitForStored = (sessionId: string, count: number) =>
	storedEvents(sessionId).pipe(
		Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (rows) => rows.length >= count }),
		Effect.timeout("10 seconds"),
	);

// Records every startSession input, so tests can check what the service passed to the agent.
const spyOn = (adapter: AgentAdapter) => {
	const inputs: Array<StartSessionInput> = [];
	const spy: AgentAdapter = {
		...adapter,
		startSession: (input) => {
			inputs.push(input);
			return adapter.startSession(input);
		},
	};
	return { inputs, spy };
};

const messages = (turnId: string, count: number): Array<AgentEvent> => [
	...Array.from(
		{ length: count },
		(_, index): AgentEvent => ({
			type: "message.completed",
			itemId: `${turnId}-${index}`,
			text: "ok",
		}),
	),
	{ type: "turn.completed", turnId, result: { status: "completed" } },
];

const runWithRecording = <A, E>(recording: Recording, program: (tempDir: string) => Effect.Effect<A, E, Services>) =>
	runInTempDir((tempDir) =>
		withServices(
			join(tempDir, "data"),
			testAgentServices({
				claude: makeReplayAdapter({ ...recording, kind: "claude" }),
				codex: makeReplayAdapter(recording),
			}),
		)(program(tempDir)),
	);

const sequences = (events: ReadonlyArray<SessionEvent>) => events.map((stored) => stored.sequence);

describe("SessionService", () => {
	test("creates idle sessions of both agents in one workspace", async () => {
		const sessions = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspace = yield* addWorkspace(tempDir);
				const service = yield* SessionService;
				yield* service.create({ workspaceId: workspace.id, agent: "claude", model: "claude-opus-5-5" });
				yield* service.create({ workspaceId: workspace.id, agent: "codex", model: "gpt-first" });
				yield* service.create({ workspaceId: workspace.id, agent: "codex", model: "gpt-first" });
				return yield* service.list(workspace.id);
			}),
		);
		expect(sessions.map((session) => [session.agent, session.status, session.authMode])).toEqual([
			["claude", "idle", "apiKey"],
			["codex", "idle", "subscription"],
			["codex", "idle", "subscription"],
		]);
	});

	test("stores events with gapless sequences and keeps deltas live only", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				const live = yield* eventsUntil(session.id, -1, "turn.completed").pipe(Effect.forkChild);
				// Let the subscription register before the turn starts.
				yield* Effect.sleep("100 millis");
				yield* sessions.sendMessage(session.id, "run the tests", false);
				yield* waitForStatus(session.id, "awaitingApproval");
				yield* sessions.respondToApproval(session.id, "0", "allowOnce");
				const received = yield* Fiber.join(live);
				yield* waitForStatus(session.id, "idle");
				const [row] = yield* sessions.list(session.workspaceId);
				return { received, stored: yield* storedEvents(session.id), row };
			}),
		);
		expect(result.received.map((stored) => [stored.event.type, stored.sequence])).toEqual([
			["session.started", 0],
			["message.delta", null],
			["message.delta", null],
			["message.completed", 1],
			["tool.started", 2],
			["approval.requested", 3],
			["approval.resolved", 4],
			["tool.completed", 5],
			["turn.completed", 6],
		]);
		expect(result.stored.map((row) => row.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(result.stored.some((row) => row.type === "message.delta")).toBe(false);
		expect(result.row?.nativeSessionId).toBe("thread-replay");
	});

	test("a cursor subscription has no gap or duplicate while events arrive during paging", async () => {
		const recording: Recording = {
			kind: "codex",
			nativeSessionId: "thread-many",
			turns: [messages("first", 450), messages("second", 450)],
		};
		const received = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "first", false);
				yield* waitForStored(session.id, 452);
				yield* sessions.sendMessage(session.id, "second", false);
				return yield* sessions.subscribe(session.id, 10).pipe(
					Stream.takeUntil((stored) => stored.event.type === "turn.completed" && stored.event.turnId === "second"),
					Stream.runCollect,
				);
			}),
		);
		// 1 session.started, then 451 events per turn, starting after the cursor at 10.
		expect(sequences(received)).toEqual(Array.from({ length: 1 + 451 * 2 - 11 }, (_, index) => index + 11));
	});

	test("a subscriber that falls behind gets ResubscribeRequiredError with its last sequence", async () => {
		const recording: Recording = {
			kind: "codex",
			nativeSessionId: "thread-burst",
			turns: [messages("warm", 1), messages("burst", 1_500)],
		};
		const result = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "warm", false);
				yield* waitForStored(session.id, 3);
				const firstReceived = yield* Deferred.make<void>();
				const gate = yield* Deferred.make<void>();
				const received: Array<SessionEvent> = [];
				const subscriber = yield* sessions.subscribe(session.id, -1).pipe(
					Stream.runForEach((stored) =>
						Effect.gen(function* () {
							received.push(stored);
							yield* Deferred.succeed(firstReceived, undefined);
							yield* Deferred.await(gate);
						}),
					),
					Effect.flip,
					Effect.forkChild,
				);
				// A history event has arrived, so the live subscription is already registered.
				yield* Deferred.await(firstReceived);
				yield* sessions.sendMessage(session.id, "burst", false);
				yield* waitForStored(session.id, 1_504);
				// Rows are stored before they are published, so give the subscriber's buffer time to fill.
				yield* Effect.sleep("200 millis");
				yield* Deferred.succeed(gate, undefined);
				const error = yield* Fiber.join(subscriber);
				return { error, received };
			}),
		);
		expect(result.error._tag).toBe("ResubscribeRequiredError");
		expect(result.received.length).toBeLessThan(1_504);
		expect(result.error._tag === "ResubscribeRequiredError" && result.error.lastSequence).toBe(
			result.received.at(-1)?.sequence ?? -1,
		);
	});

	test("caps running agents at 8 and stops the least recently used idle one for a new one", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const workspace = yield* addWorkspace(tempDir);
				const created = yield* Effect.forEach(Array.from({ length: MAX_RUNNING_SESSIONS + 1 }), () =>
					sessions.create({ workspaceId: workspace.id, agent: "codex", model: "replay" }),
				);
				for (const session of created.slice(0, MAX_RUNNING_SESSIONS)) {
					yield* sessions.sendMessage(session.id, "run the tests", false);
					yield* waitForStatus(session.id, "awaitingApproval");
				}
				const last = created[MAX_RUNNING_SESSIONS]?.id ?? "";
				const refused = yield* Effect.flip(sessions.sendMessage(last, "run the tests", false));
				const first = created[0]?.id ?? "";
				yield* sessions.respondToApproval(first, "0", "allowOnce");
				yield* waitForStatus(first, "idle");
				yield* sessions.sendMessage(last, "run the tests", false);
				yield* waitForStatus(last, "awaitingApproval");
				// The first session's process is gone, so its approval cannot be answered any more.
				const firstGone = yield* Effect.flip(sessions.respondToApproval(first, "0", "allowOnce"));
				return { refused, firstGone };
			}),
		);
		expect(result.refused).toMatchObject({ _tag: "SessionLimitReachedError", limit: 8 });
		expect(result.firstGone._tag).toBe("ApprovalNotFoundError");
	});

	test("marks sessions cut off by a restart as interrupted", async () => {
		const statuses = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const dataDir = join(tempDir, "data");
				const ids = yield* withServices(dataDir)(
					Effect.gen(function* () {
						const sessions = yield* SessionService;
						const database = yield* LocalDatabase;
						const workspace = yield* addWorkspace(tempDir);
						const ids = [];
						for (const status of ["running", "awaitingApproval", "idle"] as const) {
							const session = yield* sessions.create({ workspaceId: workspace.id, agent: "codex", model: "replay" });
							yield* database.query((db) =>
								db.update(agentSession).set({ status }).where(eq(agentSession.id, session.id)),
							);
							ids.push(session.id);
						}
						return ids;
					}),
				);
				return yield* withServices(dataDir)(Effect.forEach(ids, statusOf));
			}),
		);
		expect(statuses).toEqual(["interrupted", "interrupted", "idle"]);
	});

	test("moves through running, awaitingApproval, running and idle during an approved turn", async () => {
		const statuses = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				const watched = yield* sessions.watch.pipe(
					Stream.filter((changed) => changed.id === session.id),
					Stream.map((changed) => changed.status),
					Stream.changes,
					Stream.dropWhile((status) => status === "idle"),
					Stream.takeUntil((status) => status === "idle"),
					Stream.runCollect,
					Effect.timeout("5 seconds"),
					Effect.forkChild,
				);
				yield* Effect.sleep("100 millis");
				yield* sessions.sendMessage(session.id, "run the tests", false);
				yield* waitForStatus(session.id, "awaitingApproval");
				yield* sessions.respondToApproval(session.id, "0", "allowOnce");
				return yield* Fiber.join(watched);
			}),
		);
		expect(statuses).toEqual(["running", "awaitingApproval", "running", "idle"]);
	});

	test("interrupt during an approval cancels it, then interrupts the turn", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "run the tests", false);
				yield* waitForStatus(session.id, "awaitingApproval");
				yield* sessions.interrupt(session.id);
				const events = yield* eventsUntil(session.id, 3, "turn.completed");
				return {
					events: events.map((stored) => stored.event),
					status: yield* waitForStatus(session.id, "interrupted"),
				};
			}),
		);
		expect(result.events).toEqual([
			{ type: "approval.resolved", requestId: "0", outcome: "cancelled" },
			{ type: "turn.completed", turnId: "replay-0", result: { status: "interrupted" } },
		]);
		expect(result.status).toBe("interrupted");
	});

	test("stopSession ends the process and the next message resumes with the native id", async () => {
		const codex = spyOn(makeReplayAdapter(commandWithApproval));
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex: codex.spy }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const session = yield* addSession(tempDir);
					yield* sessions.sendMessage(session.id, "run the tests", false);
					yield* waitForStatus(session.id, "awaitingApproval");
					yield* sessions.stop(session.id);
					const afterStop = yield* statusOf(session.id);
					const events = yield* storedEvents(session.id);
					yield* sessions.sendMessage(session.id, "go on", false);
					yield* waitForStatus(session.id, "awaitingApproval");
					return { afterStop, lastType: events.at(-1)?.type, workspace: session.workspaceId };
				}),
			),
		);
		expect(result.afterStop).toBe("interrupted");
		expect(result.lastType).toBe("turn.completed");
		expect(codex.inputs.map((input) => input.resumeId)).toEqual([undefined, "thread-replay"]);
		expect(codex.inputs[0]).toMatchObject({
			model: "replay",
			trustProjectSettings: false,
			auth: { mode: "subscription" },
		});
	});

	test("Claude needs an API key before it starts", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir, "claude");
				return yield* Effect.flip(sessions.sendMessage(session.id, "hi", false));
			}),
		);
		expect(error).toMatchObject({
			_tag: "AgentUnavailableError",
			agent: "claude",
			availability: { status: "needsApiKey" },
		});
	});

	test("lists agents with availability, capabilities and models", async () => {
		const [before, after] = await runServiceTest(() =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const before = yield* sessions.listAgents;
				yield* sessions.setApiKey("claude", Redacted.make("sk-ant-test"));
				return [before, yield* sessions.listAgents] as const;
			}),
		);
		expect(before.map((agent) => [agent.kind, agent.availability])).toEqual([
			["claude", { status: "needsApiKey" }],
			["codex", { status: "ready", account: null }],
		]);
		expect(after[0]?.availability).toEqual({ status: "ready", account: null });
		expect(after[1]).toMatchObject({ defaultModel: "replay", models: [{ id: "replay", label: "Replay" }] });
	});

	test("the API key never reaches the database or the logs", async () => {
		const apiKey = "sk-ant-never-store-me-4f2a";
		const logs: Array<string> = [];
		const capture = Logger.make((options) => {
			logs.push(String(Logger.formatLogFmt.log(options)));
		});
		const claude = spyOn(makeReplayAdapter({ ...commandWithApproval, kind: "claude" }));
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: claude.spy, codex: makeReplayAdapter(commandWithApproval) }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					yield* sessions.setApiKey("claude", Redacted.make(apiKey));
					const session = yield* addSession(tempDir, "claude");
					yield* sessions.sendMessage(session.id, "run the tests", false);
					yield* waitForStatus(session.id, "awaitingApproval");
					yield* sessions.respondToApproval(session.id, "0", "allowOnce");
					yield* waitForStatus(session.id, "idle");
					yield* Effect.logInfo("Session input", claude.inputs[0]);
					const fs = yield* FileSystem.FileSystem;
					const files = yield* Effect.forEach(["", "-wal"], (suffix) =>
						fs
							.readFileString(join(tempDir, "data", `${DATABASE_FILE_NAME}${suffix}`))
							.pipe(Effect.orElseSucceed(() => "")),
					);
					return { database: files.join(""), authMode: (yield* sessions.list(session.workspaceId))[0]?.authMode };
				}),
			).pipe(Effect.provide(Logger.layer([capture]))),
		);
		const auth = claude.inputs[0]?.auth;
		expect(auth?.mode === "apiKey" && Redacted.value(auth.apiKey)).toBe(apiKey);
		expect(result.authMode).toBe("apiKey");
		expect(logs.length).toBeGreaterThan(0);
		expect(logs.join("\n")).not.toContain(apiKey);
		expect(result.database.length).toBeGreaterThan(0);
		expect(result.database).not.toContain(apiKey);
	});
});
