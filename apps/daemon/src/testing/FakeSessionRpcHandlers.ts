import {
	AgentInfo,
	type AgentKind,
	AgentSession,
	type AgentSessionStatus,
	ApprovalNotFoundError,
	AttachmentNotFoundError,
	AuthModeNotAllowedError,
	type ImageData,
	SessionBusyError,
	SessionNotFoundError,
} from "@repo/contracts/AgentSession";
import replayFixture from "../agents/replay/fixtures/commandWithApproval.json" with { type: "json" };
import { makeReplayAdapter, Recording } from "../agents/replay/ReplayAdapter.ts";
import devChatTurns from "./fixtures/devChatTurns.json" with { type: "json" };
import { Effect, Exit, PubSub, Schema, Scope, Stream } from "effect";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import type { AgentSessionHandle } from "../agents/AgentAdapter.ts";
import type { AgentEvent } from "@repo/contracts/AgentEvent";
import { SessionEvent } from "@repo/contracts/SessionEvent";
import { SessionRpcs } from "@repo/contracts/SessionRpcs";
import { nowIso } from "../database/nowIso.ts";

// A stand-in for SessionService, only for the dev daemon and UI work: every chat replays the recorded
// turns below in a loop through the real ReplayAdapter, so approvals, interrupts and queueing behave
// like a real agent. It keeps everything in memory and is never part of the shipped daemon.

const CYCLES = 20;
const DELTA_DELAY = "25 millis";
const EVENT_DELAY = "250 millis";
const ID_KEYS = new Set(["itemId", "requestId", "turnId"]);

// Repeats the turns with fresh ids each time, so the chat never shows two items as one.
const distinctTurns = [...replayFixture.turns, ...devChatTurns].length;
const rawTurns = Array.from({ length: CYCLES }, (_, cycle) =>
	[...replayFixture.turns, ...devChatTurns].map((turn) =>
		JSON.parse(JSON.stringify(turn), (key, value) => (ID_KEYS.has(key) ? `${value}-${cycle}` : value)),
	),
).flat();

// Recorded messages arrive whole. Split them into word deltas so the chat streams like a real one.
const withDeltas = (event: AgentEvent): ReadonlyArray<AgentEvent> =>
	event.type === "message.completed"
		? [
				...(event.text.match(/\S+\s*/g) ?? []).map(
					(text) => ({ type: "message.delta", itemId: event.itemId, text }) as const,
				),
				event,
			]
		: [event];

const agentInfos = (apiKeys: ReadonlySet<AgentKind>, codexMode: "subscription" | "apiKey") => {
	const capabilities = {
		resume: true,
		interrupt: true,
		fileChangeApprovals: true,
		mcpApprovals: true,
		steerWhileRunning: false,
	};
	return [
		new AgentInfo({
			kind: "claude",
			availability: apiKeys.has("claude") ? { status: "ready", account: null } : { status: "needsApiKey" },
			capabilities,
			authModes: ["apiKey"],
			authMode: "apiKey",
			models: [
				{
					id: "claude-opus",
					label: "Opus",
					description: "Most capable for hard problems",
					efforts: ["low", "medium", "high"],
					defaultEffort: "medium",
					contextWindow: 200_000,
					supportsImages: true,
				},
				{
					id: "claude-haiku",
					label: "Haiku",
					description: "Fastest for quick answers",
					efforts: [],
					defaultEffort: null,
					contextWindow: 200_000,
					supportsImages: true,
				},
			],
			defaultModel: "claude-opus",
		}),
		new AgentInfo({
			kind: "codex",
			availability:
				codexMode === "apiKey" && !apiKeys.has("codex")
					? { status: "needsApiKey" }
					: { status: "ready", account: codexMode === "subscription" ? "dev@example.com" : null },
			capabilities,
			authModes: ["subscription", "apiKey"],
			authMode: codexMode,
			models: [
				{
					id: "gpt-codex",
					label: "GPT Codex",
					description: "Tuned for coding",
					efforts: ["minimal", "low", "medium", "high"],
					defaultEffort: "medium",
					contextWindow: 272_000,
					supportsImages: true,
				},
				{
					id: "codex-mini",
					label: "Codex Mini",
					description: "Text only, lower cost",
					efforts: ["low", "medium"],
					defaultEffort: "low",
					contextWindow: 128_000,
					supportsImages: false,
				},
			],
			defaultModel: "gpt-codex",
		}),
	];
};

const queueFull = (error: { readonly queued: number }) => Effect.fail(new SessionBusyError({ queued: error.queued }));

interface FakeSession {
	session: AgentSession;
	readonly events: Array<SessionEvent>;
	readonly live: PubSub.PubSub<SessionEvent>;
	readonly attachments: Map<string, ImageData>;
	agent: { readonly handle: AgentSessionHandle; readonly scope: Scope.Closeable } | null;
	// Messages sent whose turn has not completed yet. Above one, the rest wait in the agent's queue.
	turnsOwed: number;
}

export const FakeSessionRpcHandlers = SessionRpcs.toLayer(
	Effect.gen(function* () {
		const workspaces = yield* WorkspaceService;
		const { turns } = yield* Schema.decodeUnknownEffect(Recording)({
			kind: "codex",
			nativeSessionId: "thread-dev",
			turns: rawTurns,
		}).pipe(Effect.orDie);
		const recording = {
			kind: "codex" as const,
			nativeSessionId: "thread-dev",
			turns: turns.map((turn) => turn.flatMap(withDeltas)),
		};
		yield* Effect.logInfo("Fake sessions replay recorded turns").pipe(Effect.annotateLogs({ turns: distinctTurns }));

		const sessions = new Map<string, FakeSession>();
		const watchers = yield* PubSub.unbounded<AgentSession>();
		const apiKeys = new Set<AgentKind>();
		let codexMode: "subscription" | "apiKey" = "subscription";
		let nextId = 0;
		const newFakeId = (prefix: string) => `${prefix}-${++nextId}`;

		const find = (sessionId: string) => {
			const found = sessions.get(sessionId);
			return found === undefined ? Effect.fail(new SessionNotFoundError({ sessionId })) : Effect.succeed(found);
		};

		const update = Effect.fnUntraced(function* (
			fake: FakeSession,
			changes: Partial<Pick<AgentSession, "status" | "title" | "model" | "effort" | "nativeSessionId">>,
		) {
			fake.session = new AgentSession({ ...fake.session, ...changes, updatedAt: yield* nowIso });
			PubSub.publishUnsafe(watchers, fake.session);
			return fake.session;
		});

		const record = Effect.fnUntraced(function* (fake: FakeSession, event: AgentEvent) {
			const stored = event.type !== "message.delta";
			const sessionEvent = new SessionEvent({
				sessionId: fake.session.id,
				sequence: stored ? fake.events.length : null,
				event,
				createdAt: yield* nowIso,
			});
			if (stored) {
				fake.events.push(sessionEvent);
			}
			PubSub.publishUnsafe(fake.live, sessionEvent);
			const status = statusAfter(fake, event);
			if (status !== null && status !== fake.session.status) {
				yield* update(fake, { status });
			}
			if (event.type === "session.started") {
				yield* update(fake, { nativeSessionId: event.nativeSessionId });
			}
		});

		const statusAfter = (fake: FakeSession, event: AgentEvent): AgentSessionStatus | null => {
			switch (event.type) {
				case "approval.requested":
					return "awaitingApproval";
				case "approval.resolved":
					return "running";
				case "turn.completed":
					fake.turnsOwed = Math.max(0, fake.turnsOwed - 1);
					if (fake.turnsOwed > 0) {
						return "running";
					}
					return event.result.status === "completed" ? "idle" : event.result.status;
				default:
					return null;
			}
		};

		const startAgent = Effect.fnUntraced(function* (fake: FakeSession) {
			const scope = yield* Scope.make();
			const handle = yield* makeReplayAdapter(recording)
				.startSession({
					cwd: "/",
					model: fake.session.model,
					trustProjectSettings: false,
					auth: { mode: "subscription" },
				})
				.pipe(Scope.provide(scope), Effect.orDie);
			yield* handle.events.pipe(
				Stream.tap((event) =>
					Effect.sleep(event.type === "message.delta" ? DELTA_DELAY : EVENT_DELAY).pipe(
						Effect.andThen(record(fake, event)),
					),
				),
				Stream.runDrain,
				Effect.catch(() => update(fake, { status: "failed" })),
				Effect.forkIn(scope),
			);
			fake.agent = { handle, scope };
			return handle;
		});

		const stopAgent = Effect.fnUntraced(function* (fake: FakeSession) {
			if (fake.agent !== null) {
				yield* Scope.close(fake.agent.scope, Exit.void);
				fake.agent = null;
				fake.turnsOwed = 0;
			}
		});

		return SessionRpcs.of({
			listAgents: () => Effect.sync(() => agentInfos(apiKeys, codexMode)),
			setAgentApiKey: ({ agent }) => Effect.sync(() => void apiKeys.add(agent)),
			removeAgentApiKey: ({ agent }) => Effect.sync(() => void apiKeys.delete(agent)),
			setAgentAuthMode: ({ agent, mode }) =>
				agent === "claude" && mode === "subscription"
					? Effect.fail(new AuthModeNotAllowedError({ agent, mode }))
					: Effect.sync(() => {
							if (agent === "codex") codexMode = mode;
						}),
			startAgentLogin: ({ agent }) =>
				agent === "claude"
					? Effect.fail(new AuthModeNotAllowedError({ agent, mode: "subscription" }))
					: Effect.succeed({ authUrl: "https://example.com/fake-codex-login" }),
			createSession: ({ workspaceId, agent, model, effort }) =>
				Effect.gen(function* () {
					yield* workspaces.get(workspaceId).pipe(Effect.catchTag("LocalDatabaseError", Effect.die));
					const now = yield* nowIso;
					const session = new AgentSession({
						id: newFakeId("session"),
						workspaceId,
						agent,
						model,
						nativeSessionId: null,
						authMode: agent === "claude" ? "apiKey" : codexMode,
						effort,
						status: "idle",
						title: null,
						createdAt: now,
						updatedAt: now,
					});
					sessions.set(session.id, {
						session,
						events: [],
						live: yield* PubSub.unbounded<SessionEvent>(),
						attachments: new Map(),
						agent: null,
						turnsOwed: 0,
					});
					PubSub.publishUnsafe(watchers, session);
					return session;
				}),
			listSessions: ({ workspaceId }) =>
				Effect.sync(() =>
					[...sessions.values()].map((fake) => fake.session).filter((session) => session.workspaceId === workspaceId),
				),
			renameSession: ({ sessionId, title }) =>
				Effect.flatMap(find(sessionId), (fake) => update(fake, { title: title.trim() || null })),
			updateSessionSettings: ({ sessionId, model, effort }) =>
				Effect.flatMap(find(sessionId), (fake) => update(fake, { model, effort })),
			sendMessage: ({ sessionId, text, images, steer }) =>
				Effect.gen(function* () {
					const fake = yield* find(sessionId);
					const attachments = images.map((image) => {
						const id = newFakeId("attachment");
						fake.attachments.set(id, image);
						return { id, mediaType: image.mediaType };
					});
					const handle = fake.agent?.handle ?? (yield* startAgent(fake));
					yield* handle.sendMessage(text, { steer }).pipe(
						Effect.catchTags({
							SessionBusyError: queueFull,
							AgentProcessError: Effect.die,
							AgentNotInstalledError: Effect.die,
							AgentProtocolError: Effect.die,
							CodexVersionMismatchError: Effect.die,
						}),
					);
					fake.turnsOwed++;
					yield* record(fake, { type: "user.message", itemId: newFakeId("user"), text, attachments });
					if (fake.session.status !== "awaitingApproval") {
						yield* update(fake, { status: "running" });
					}
				}),
			getAttachment: ({ sessionId, attachmentId }) =>
				Effect.flatMap(find(sessionId), (fake) => {
					const image = fake.attachments.get(attachmentId);
					return image === undefined
						? Effect.fail(new AttachmentNotFoundError({ attachmentId }))
						: Effect.succeed(image);
				}),
			respondToApproval: ({ sessionId, requestId, decision }) =>
				Effect.gen(function* () {
					const fake = yield* find(sessionId);
					if (fake.agent === null) {
						return yield* new ApprovalNotFoundError({ requestId });
					}
					const notFound = () => Effect.fail(new ApprovalNotFoundError({ requestId }));
					yield* fake.agent.handle.respondToApproval(requestId, decision).pipe(
						Effect.catchTags({
							ApprovalNotFoundError: notFound,
							ApprovalChoiceError: notFound,
						}),
						Effect.orDie,
					);
				}),
			interruptSession: ({ sessionId }) =>
				Effect.gen(function* () {
					const fake = yield* find(sessionId);
					// Queued messages are dropped with the turn, as a real interrupt does.
					fake.turnsOwed = Math.min(fake.turnsOwed, 1);
					if (fake.agent !== null) {
						yield* fake.agent.handle.interrupt.pipe(Effect.orDie);
					}
				}),
			stopSession: ({ sessionId }) =>
				Effect.gen(function* () {
					const fake = yield* find(sessionId);
					yield* stopAgent(fake);
					yield* update(fake, { status: "idle" });
				}),
			subscribeSession: ({ sessionId, afterSequence }) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const fake = yield* find(sessionId);
						// Subscribe before taking the snapshot, then skip what the snapshot already holds.
						const subscription = yield* PubSub.subscribe(fake.live);
						const snapshot = fake.events.filter((event) => (event.sequence ?? -1) > afterSequence);
						const lastSequence = fake.events.length - 1;
						return Stream.concat(
							Stream.fromIterable(snapshot),
							Stream.fromSubscription(subscription).pipe(
								Stream.filter((event) => event.sequence === null || event.sequence > lastSequence),
							),
						);
					}),
				),
			watchSessions: () => Stream.fromPubSub(watchers),
		});
	}),
);
