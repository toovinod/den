import {
	type AgentAdapter,
	AgentNotInstalledError,
	AgentProtocolError,
	type StartSessionInput,
} from "../agents/AgentAdapter.ts";
import {
	Deferred,
	Duration,
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Logger,
	Redacted,
	Schedule,
	Schema,
	Stream,
} from "effect";
import { commandWithApproval, TEST_LOGIN_URL, testAgentServices } from "../testing/testAgentServices.ts";
import { runInTempDir, runServiceTest, type Services, withServices } from "../testing/runServiceTest.ts";
import { makeReplayAdapter, type Recording } from "../agents/replay/ReplayAdapter.ts";
import { CredentialStore, CredentialStoreError } from "../agents/CredentialStore.ts";
import type { AgentSessionStatus, AgentKind } from "@repo/contracts/AgentSession";
import { DATABASE_FILE_NAME, LocalDatabase } from "../database/LocalDatabase.ts";
import { MAX_RUNNING_SESSIONS, SessionService } from "./SessionService.ts";
import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { agentSession, sessionEvent } from "../database/schema.ts";
import { makeAgentSession } from "../agents/makeAgentSession.ts";
import type { SessionEvent } from "@repo/contracts/SessionEvent";
import { ProjectService } from "../projects/ProjectService.ts";
import { AgentProbeSettings } from "./AgentProbeSettings.ts";
import { AgentEvent } from "@repo/contracts/AgentEvent";
import { describe, expect, test } from "bun:test";
import { runGit } from "../git/runGit.ts";
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
	return yield* sessions.create({ workspaceId: workspace.id, agent, model: "replay", effort: null });
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
				yield* service.create({ workspaceId: workspace.id, agent: "claude", model: "claude-opus-5-5", effort: null });
				yield* service.create({ workspaceId: workspace.id, agent: "codex", model: "gpt-first", effort: null });
				yield* service.create({ workspaceId: workspace.id, agent: "codex", model: "gpt-first", effort: null });
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
				yield* sessions.sendMessage(session.id, "run the tests", [], false);
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
			["user.message", 1],
			["message.delta", null],
			["message.delta", null],
			["message.completed", 2],
			["tool.started", 3],
			["approval.requested", 4],
			["approval.resolved", 5],
			["tool.completed", 6],
			["turn.completed", 7],
		]);
		expect(result.stored.map((row) => row.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
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
				yield* sessions.sendMessage(session.id, "first", [], false);
				yield* waitForStored(session.id, 453);
				yield* sessions.sendMessage(session.id, "second", [], false);
				return yield* sessions.subscribe(session.id, 10).pipe(
					Stream.takeUntil((stored) => stored.event.type === "turn.completed" && stored.event.turnId === "second"),
					Stream.runCollect,
				);
			}),
		);
		// 1 session.started, then the user message and 451 agent events per turn, starting after the cursor at 10.
		expect(sequences(received)).toEqual(Array.from({ length: 1 + 452 * 2 - 11 }, (_, index) => index + 11));
	});

	test("pages stored history backwards, and a subscription after the latest page joins it", async () => {
		// session.started, the user message and 8 agent events: sequences 0 to 9.
		const recording: Recording = { kind: "codex", nativeSessionId: "thread-pages", turns: [messages("first", 7)] };
		const result = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				const empty = yield* sessions.history(session.id, null, 4);
				yield* sessions.sendMessage(session.id, "first", [], false);
				yield* waitForStored(session.id, 10);
				const latest = yield* sessions.history(session.id, null, 4);
				const before = yield* sessions.history(session.id, 6, 4);
				const oldest = yield* sessions.history(session.id, 2, 4);
				const exact = yield* sessions.history(session.id, 10, 10);
				const first = yield* sessions.history(session.id, 0, 4);
				const missing = yield* Effect.flip(sessions.history("nope", null, 4));
				yield* sessions.sendMessage(session.id, "second", [], false);
				const joined = yield* sessions.subscribe(session.id, latest.at(-1)?.sequence ?? -1).pipe(
					Stream.takeUntil((stored) => stored.event.type === "turn.completed"),
					Stream.runCollect,
					Effect.timeout("5 seconds"),
				);
				return { empty, latest, before, oldest, exact, first, missing, joined };
			}),
		);
		expect(result.empty).toEqual([]);
		expect(sequences(result.latest)).toEqual([6, 7, 8, 9]);
		expect(sequences(result.before)).toEqual([2, 3, 4, 5]);
		expect(sequences(result.oldest)).toEqual([0, 1]);
		expect(sequences(result.exact)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(result.first).toEqual([]);
		expect(result.missing._tag).toBe("SessionNotFoundError");
		// The second message has no recorded turn, so it fails at once: its user message, then turn.completed.
		expect(sequences(result.joined)).toEqual([10, 11]);
	});

	test("a failed turn leaves the session failed, and the next message still runs", async () => {
		const recording: Recording = {
			kind: "codex",
			nativeSessionId: "thread-failed",
			turns: [
				[{ type: "turn.completed", turnId: "broken", result: { status: "failed", message: "Rate limited" } }],
				messages("retry", 1),
			],
		};
		const statuses = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "first", [], false);
				yield* waitForStatus(session.id, "failed");
				const afterFailure = yield* statusOf(session.id);
				yield* sessions.sendMessage(session.id, "again", [], false);
				yield* waitForStored(session.id, 6);
				yield* waitForStatus(session.id, "idle");
				return [afterFailure, yield* statusOf(session.id)];
			}),
		);
		expect(statuses).toEqual(["failed", "idle"]);
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
				yield* sessions.sendMessage(session.id, "warm", [], false);
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
				yield* sessions.sendMessage(session.id, "burst", [], false);
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

	test("counts a subscriber's buffer in UTF-8 bytes, not characters", async () => {
		// 200 messages of 2,000 three-byte characters: 0.4 million characters, but 1.2 MB, over the 1 MB budget.
		const wide = "\u6f22".repeat(2_000);
		const burst: Array<AgentEvent> = [
			...Array.from(
				{ length: 200 },
				(_, index): AgentEvent => ({
					type: "message.completed",
					itemId: `wide-${index}`,
					text: wide,
				}),
			),
			{ type: "turn.completed", turnId: "burst", result: { status: "completed" } },
		];
		const recording: Recording = { kind: "codex", nativeSessionId: "thread-wide", turns: [messages("warm", 1), burst] };
		const outcome = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "warm", [], false);
				yield* waitForStored(session.id, 3);
				const firstReceived = yield* Deferred.make<void>();
				const gate = yield* Deferred.make<void>();
				const subscriber = yield* sessions.subscribe(session.id, -1).pipe(
					Stream.takeUntil((stored) => stored.event.type === "turn.completed" && stored.event.turnId === "burst"),
					Stream.runForEach(() =>
						Effect.gen(function* () {
							yield* Deferred.succeed(firstReceived, undefined);
							yield* Deferred.await(gate);
						}),
					),
					Effect.result,
					Effect.forkChild,
				);
				yield* Deferred.await(firstReceived);
				yield* sessions.sendMessage(session.id, "burst", [], false);
				yield* waitForStored(session.id, 205);
				yield* Effect.sleep("200 millis");
				yield* Deferred.succeed(gate, undefined);
				return yield* Fiber.join(subscriber).pipe(Effect.timeout("5 seconds"));
			}),
		);
		expect(outcome._tag === "Failure" && outcome.failure._tag).toBe("ResubscribeRequiredError");
	});

	test("caps running agents at 8 and stops the least recently used idle one for a new one", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const workspace = yield* addWorkspace(tempDir);
				const created = yield* Effect.forEach(Array.from({ length: MAX_RUNNING_SESSIONS + 1 }), () =>
					sessions.create({ workspaceId: workspace.id, agent: "codex", model: "replay", effort: null }),
				);
				for (const session of created.slice(0, MAX_RUNNING_SESSIONS)) {
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					yield* waitForStatus(session.id, "awaitingApproval");
				}
				const last = created[MAX_RUNNING_SESSIONS]?.id ?? "";
				const refused = yield* Effect.flip(sessions.sendMessage(last, "run the tests", [], false));
				const first = created[0]?.id ?? "";
				yield* sessions.respondToApproval(first, "0", "allowOnce");
				yield* waitForStatus(first, "idle");
				yield* sessions.sendMessage(last, "run the tests", [], false);
				yield* waitForStatus(last, "awaitingApproval");
				// The first session's process is gone, so its approval cannot be answered any more.
				const firstGone = yield* Effect.flip(sessions.respondToApproval(first, "0", "allowOnce"));
				return { refused, firstGone };
			}),
		);
		expect(result.refused).toMatchObject({ _tag: "SessionLimitReachedError", limit: 8 });
		expect(result.firstGone._tag).toBe("ApprovalNotFoundError");
	});

	test("watching starts with every session of the active workspaces, then follows changes", async () => {
		const titles = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const workspaces = yield* WorkspaceService;
				const session = yield* addSession(tempDir);
				const workspace = yield* workspaces.get(session.workspaceId);
				const old = yield* workspaces.create({ kind: "worktree", projectId: workspace.projectId, name: "old" });
				yield* sessions.create({ workspaceId: old.id, agent: "codex", model: "replay", effort: null });
				yield* workspaces.archive(old.id, { force: false });
				// Every session above changed before the watch began, so only its first items can report them.
				const watched = yield* sessions.watch.pipe(
					Stream.take(2),
					Stream.runCollect,
					Effect.timeout("5 seconds"),
					Effect.forkChild,
				);
				yield* Effect.sleep("100 millis");
				yield* sessions.rename(session.id, "Renamed");
				return (yield* Fiber.join(watched)).map((changed) => [changed.id === session.id, changed.title]);
			}),
		);
		expect(titles).toEqual([
			[true, null],
			[true, "Renamed"],
		]);
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
							const session = yield* sessions.create({
								workspaceId: workspace.id,
								agent: "codex",
								model: "replay",
								effort: null,
							});
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
				yield* sessions.sendMessage(session.id, "run the tests", [], false);
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
				yield* sessions.sendMessage(session.id, "run the tests", [], false);
				yield* waitForStatus(session.id, "awaitingApproval");
				yield* sessions.interrupt(session.id);
				const events = yield* eventsUntil(session.id, 4, "turn.completed");
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
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					yield* waitForStatus(session.id, "awaitingApproval");
					yield* sessions.stop(session.id);
					const afterStop = yield* statusOf(session.id);
					const events = yield* storedEvents(session.id);
					yield* sessions.sendMessage(session.id, "go on", [], false);
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

	test("archiving a workspace stops its agent processes", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "run the tests", [], false);
				yield* waitForStatus(session.id, "awaitingApproval");
				yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.archive(session.workspaceId, { force: false }),
				);
				return {
					status: yield* statusOf(session.id),
					approval: yield* Effect.flip(sessions.respondToApproval(session.id, "0", "allowOnce")),
					message: yield* Effect.flip(sessions.sendMessage(session.id, "one more thing", [], false)),
				};
			}),
		);
		expect(result.status).toBe("interrupted");
		expect(result.approval._tag).toBe("ApprovalNotFoundError");
		expect(result.message._tag).toBe("WorkspaceArchivedError");
	});

	test("stores sent images privately, records only their ids, and deletes them on archive", async () => {
		const image = { mediaType: "image/png", base64: Buffer.from("png bytes").toString("base64") } as const;
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const fs = yield* FileSystem.FileSystem;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "look", [image], false);
				const [, stored] = yield* waitForStored(session.id, 2);
				const event = Schema.decodeUnknownSync(AgentEvent)(stored?.payload);
				const attachmentId = event.type === "user.message" ? (event.attachments[0]?.id ?? "") : "";
				const path = join(tempDir, "data", "attachments", session.id, attachmentId);
				const mode = ((yield* fs.stat(path)).mode & 0o777).toString(8);
				const served = yield* sessions.getAttachment(session.id, attachmentId);
				const unknown = yield* Effect.flip(sessions.getAttachment(session.id, "../../den.db"));
				yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.archive(session.workspaceId, { force: false }),
				);
				return { event, mode, served, unknown, removed: !(yield* fs.exists(path)) };
			}),
		);
		expect(result.event).toMatchObject({
			type: "user.message",
			text: "look",
			attachments: [{ mediaType: "image/png" }],
		});
		expect(JSON.stringify(result.event)).not.toContain(image.base64);
		expect(result.mode).toBe("600");
		expect(result.served).toEqual(image);
		expect(result.unknown._tag).toBe("AttachmentNotFoundError");
		expect(result.removed).toBe(true);
	});

	test("keeps sent images when archiving the workspace fails", async () => {
		const image = { mediaType: "image/png", base64: Buffer.from("png bytes").toString("base64") } as const;
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const workspaces = yield* WorkspaceService;
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				const project = yield* Effect.flatMap(ProjectService, (projects) => projects.add(path));
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				const session = yield* sessions.create({
					workspaceId: created.id,
					agent: "codex",
					model: "replay",
					effort: null,
				});
				yield* sessions.sendMessage(session.id, "look", [image], false);
				const [, stored] = yield* waitForStored(session.id, 2);
				const event = Schema.decodeUnknownSync(AgentEvent)(stored?.payload);
				const attachmentId = event.type === "user.message" ? (event.attachments[0]?.id ?? "") : "";
				// A locked worktree refuses `git worktree remove`, so the archive fails.
				yield* runGit(path, ["worktree", "lock", created.path]);
				const failed = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				return {
					failed,
					status: (yield* workspaces.get(created.id)).status,
					served: yield* sessions.getAttachment(session.id, attachmentId),
				};
			}),
		);
		expect(result.failed._tag).toBe("WorktreeRemoveError");
		expect(result.status).toBe("active");
		expect(result.served).toEqual(image);
	});

	test("a steer the agent rejects leaves no message in history and no image on disk", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		// A turn that keeps running, so the next message steers, and an agent that rejects every steer.
		const codex: AgentAdapter = {
			...replay,
			capabilities: { ...replay.capabilities, steerWhileRunning: true },
			startSession: () =>
				Effect.gen(function* () {
					const session = yield* makeAgentSession({ ...replay.capabilities, steerWhileRunning: true });
					yield* session.setNativeSessionId("thread-steer");
					return yield* session.start({
						startTurn: () => session.emit({ type: "message.completed", itemId: "working", text: "working" }),
						steerTurn: () => Effect.fail(new AgentProtocolError({ message: "No active turn", cause: null })),
						interruptTurn: Effect.void,
						updateSettings: () => Effect.void,
					});
				}),
		};
		const image = { mediaType: "image/png", base64: Buffer.from("png bytes").toString("base64") } as const;
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const fs = yield* FileSystem.FileSystem;
					const session = yield* addSession(tempDir);
					yield* sessions.sendMessage(session.id, "first", [], false);
					yield* waitForStored(session.id, 3);
					const error = yield* Effect.flip(sessions.sendMessage(session.id, "steer", [image], true));
					// Give a wrongly recorded message time to reach the database.
					yield* Effect.sleep("100 millis");
					const directory = join(tempDir, "data", "attachments", session.id);
					return {
						error,
						types: (yield* storedEvents(session.id)).map((row) => row.type),
						files: (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [],
					};
				}),
			),
		);
		expect(result.error._tag).toBe("AgentUnavailableError");
		expect(result.types).toEqual(["session.started", "user.message", "message.completed"]);
		expect(result.files).toEqual([]);
	});

	test("refuses images for a model that cannot read them", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		const { models } = await Effect.runPromise(replay.listModels);
		const codex: AgentAdapter = {
			...replay,
			listModels: Effect.succeed({
				models: models.map((model) => ({ ...model, supportsImages: false })),
				defaultModel: "replay",
			}),
		};
		const error = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const session = yield* addSession(tempDir);
					const sessions = yield* SessionService;
					return yield* Effect.flip(
						sessions.sendMessage(session.id, "look", [{ mediaType: "image/png", base64: "aGk=" }], false),
					);
				}),
			),
		);
		expect(error._tag).toBe("ImagesNotSupportedError");
	});

	test("stores model and effort and hands changes to the running agent", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		const changes: Array<unknown> = [];
		const inputs: Array<StartSessionInput> = [];
		const codex: AgentAdapter = {
			...replay,
			startSession: (input) =>
				Effect.map(replay.startSession(input), (handle) => {
					inputs.push(input);
					return { ...handle, updateSettings: (settings) => Effect.sync(() => void changes.push(settings)) };
				}),
		};
		const updated = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const workspace = yield* addWorkspace(tempDir);
					const session = yield* sessions.create({
						workspaceId: workspace.id,
						agent: "codex",
						model: "replay",
						effort: "low",
					});
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					return yield* sessions.updateSettings(session.id, { model: "other", effort: "high" });
				}),
			),
		);
		expect(inputs[0]).toMatchObject({ model: "replay", effort: "low" });
		expect(changes).toEqual([{ model: "other", effort: "high" }]);
		expect(updated).toMatchObject({ model: "other", effort: "high" });
	});

	test("keeps the stored settings when the running agent refuses the change", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		const codex: AgentAdapter = {
			...replay,
			startSession: (input) =>
				Effect.map(replay.startSession(input), (handle) => ({
					...handle,
					updateSettings: () => Effect.fail(new AgentProtocolError({ message: "Unknown model", cause: null })),
				})),
		};
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const session = yield* addSession(tempDir);
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					const error = yield* Effect.flip(sessions.updateSettings(session.id, { model: "other", effort: "high" }));
					const [row] = yield* sessions.list(session.workspaceId);
					return { error, row };
				}),
			),
		);
		expect(result.error._tag).toBe("AgentProtocolError");
		expect(result.row).toMatchObject({ model: "replay", effort: null });
	});

	test("Claude needs an API key before it starts", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir, "claude");
				return yield* Effect.flip(sessions.sendMessage(session.id, "hi", [], false));
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

	test("reports a missing CLI even when an API key is stored", async () => {
		const claude: AgentAdapter = {
			...makeReplayAdapter({ ...commandWithApproval, kind: "claude" }),
			checkAuth: Effect.fail(new AgentNotInstalledError({ executable: "claude" })),
		};
		const agents = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude, codex: makeReplayAdapter(commandWithApproval) }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					yield* sessions.setApiKey("claude", Redacted.make("sk-ant-test"));
					return yield* sessions.listAgents;
				}),
			),
		);
		expect(agents[0]?.availability).toEqual({ status: "notInstalled" });
	});

	test("lists both agents when the keychain cannot be read", async () => {
		const brokenKeychain = Layer.succeed(
			CredentialStore,
			CredentialStore.of({
				get: () => Effect.fail(new CredentialStoreError({ cause: "locked" })),
				set: () => Effect.void,
				remove: () => Effect.void,
			}),
		);
		const agents = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				Layer.merge(testAgentServices(), brokenKeychain),
			)(Effect.flatMap(SessionService, (sessions) => sessions.listAgents)),
		);
		expect(agents.map((agent) => [agent.kind, agent.availability.status])).toEqual([
			["claude", "unknown"],
			["codex", "unknown"],
		]);
	});

	test("an agent that never answers its probe is reported, not waited on", async () => {
		const claude: AgentAdapter = {
			...makeReplayAdapter({ ...commandWithApproval, kind: "claude" }),
			checkAuth: Effect.never,
		};
		const agents = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude, codex: makeReplayAdapter(commandWithApproval) }),
			)(
				Effect.flatMap(SessionService, (sessions) => sessions.listAgents).pipe(
					Effect.provideService(AgentProbeSettings, { timeout: Duration.millis(50) }),
				),
			),
		);
		expect(agents.map((agent) => [agent.kind, agent.availability.status])).toEqual([
			["claude", "unknown"],
			["codex", "ready"],
		]);
	});

	test("asks each agent for its models once per daemon run", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		let calls = 0;
		const codex: AgentAdapter = {
			...replay,
			listModels: Effect.andThen(
				Effect.sync(() => calls++),
				replay.listModels,
			),
		};
		await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(Effect.flatMap(SessionService, (sessions) => Effect.repeat(sessions.listAgents, { times: 2 }))),
		);
		expect(calls).toBe(1);
	});

	test("asks for an agent's models again after its sign-in changes", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		let calls = 0;
		const codex: AgentAdapter = {
			...replay,
			listModels: Effect.andThen(
				Effect.sync(() => calls++),
				replay.listModels,
			),
		};
		const counts = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const countAfter = <E>(change: Effect.Effect<void, E>) =>
						Effect.gen(function* () {
							yield* change;
							yield* sessions.listAgents;
							return calls;
						});
					return [
						yield* countAfter(Effect.void),
						yield* countAfter(sessions.setApiKey("codex", Redacted.make("sk-test"))),
						yield* countAfter(sessions.setAuthMode("codex", "apiKey")),
						yield* countAfter(sessions.removeApiKey("codex")),
						// Another agent's key leaves this agent's models alone.
						yield* countAfter(sessions.setApiKey("claude", Redacted.make("sk-ant-test"))),
					];
				}),
			),
		);
		expect(counts).toEqual([1, 2, 3, 4, 4]);
	});

	test("keeps Claude on API keys and lets Codex switch between its sign-in modes", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const claudeRefused = yield* Effect.flip(sessions.setAuthMode("claude", "subscription"));
				const loginRefused = yield* Effect.flip(sessions.startLogin("claude"));
				const login = yield* sessions.startLogin("codex");
				yield* sessions.setAuthMode("codex", "apiKey");
				const [, codex] = yield* sessions.listAgents;
				const session = yield* addSession(tempDir);
				const needsKey = yield* Effect.flip(sessions.sendMessage(session.id, "hi", [], false));
				return { claudeRefused, loginRefused, login, codex, session, needsKey };
			}),
		);
		expect(result.claudeRefused._tag).toBe("AuthModeNotAllowedError");
		expect(result.loginRefused._tag).toBe("AuthModeNotAllowedError");
		expect(result.login.authUrl).toBe(TEST_LOGIN_URL);
		expect(result.codex).toMatchObject({
			authModes: ["apiKey", "subscription"],
			authMode: "apiKey",
			availability: { status: "needsApiKey" },
		});
		expect(result.session.authMode).toBe("apiKey");
		expect(result.needsKey).toMatchObject({ _tag: "AgentUnavailableError", availability: { status: "needsApiKey" } });
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
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
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
