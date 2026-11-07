import {
	type AgentAuthMode,
	type AgentAvailability,
	AgentInfo,
	type AgentKind,
	AgentSession,
	type AgentSessionStatus,
	AgentUnavailableError,
	ApprovalNotFoundError,
	ResubscribeRequiredError,
	SessionLimitReachedError,
	SessionNotFoundError,
} from "@repo/contracts/AgentSession";
import {
	type Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	PubSub,
	Queue,
	type Redacted,
	Result,
	Schema,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import type {
	AgentAdapter,
	AgentAuthStatus,
	AgentError,
	AgentSessionHandle,
	StartSessionInput,
} from "../agents/AgentAdapter.ts";
import { agentSession, project, sessionEvent, workspace } from "../database/schema.ts";
import { AgentEvent, type ApprovalDecision } from "@repo/contracts/AgentEvent";
import { WorkspaceNotFoundError } from "@repo/contracts/Workspace";
import { ClaudeAdapter } from "../agents/claude/ClaudeAdapter.ts";
import { CodexAdapter } from "../agents/codex/CodexAdapter.ts";
import { CredentialStore } from "../agents/CredentialStore.ts";
import { and, asc, eq, gt, inArray, max } from "drizzle-orm";
import { LocalDatabase } from "../database/LocalDatabase.ts";
import { SessionEvent } from "@repo/contracts/SessionEvent";
import type { SecureRandom } from "effect/crypto";
import { nowIso } from "../database/nowIso.ts";
import { newId } from "../database/newId.ts";

// Agent processes are the expensive part, so only they are capped. Sessions are unlimited.
export const MAX_RUNNING_SESSIONS = 8;
const HISTORY_PAGE_SIZE = 200;
const SUBSCRIBER_MAX_EVENTS = 1_000;
const SUBSCRIBER_MAX_BYTES = 1_000_000;
const STOP_GRACE = "5 seconds";

type SessionRow = typeof agentSession.$inferSelect;
type RestingStatus = Extract<AgentSessionStatus, "idle" | "interrupted" | "failed">;

// The live agent process of one session and what the daemon tracks about its turns.
interface Runtime {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly agent: AgentKind;
	readonly handle: AgentSessionHandle;
	// Owns the agent process. Closing it ends the process.
	readonly scope: Scope.Closeable;
	// Completes once every event of the process is stored.
	readonly done: Deferred.Deferred<void>;
	nextSequence: number;
	// Turns sent and not yet completed, including queued ones.
	outstanding: number;
	readonly approvals: Set<string>;
	// The status when no turn or approval is pending.
	resting: RestingStatus;
	status: AgentSessionStatus;
}

interface Published {
	readonly event: SessionEvent;
	readonly bytes: number;
}

const isBusy = (status: AgentSessionStatus) => status === "running" || status === "awaitingApproval";

const statusOf = (runtime: Runtime): AgentSessionStatus =>
	runtime.approvals.size > 0 ? "awaitingApproval" : runtime.outstanding > 0 ? "running" : runtime.resting;

// Claude's subscription login stays off until Anthropic approves it (architecture section 2.1).
const authModeFor = (agent: AgentKind, hasApiKey: boolean): AgentAuthMode =>
	hasApiKey || agent === "claude" ? "apiKey" : "subscription";

const toAvailability = (error: AgentError): AgentAvailability => {
	switch (error._tag) {
		case "AgentNotInstalledError":
			return { status: "notInstalled" };
		case "CodexVersionMismatchError":
			return { status: "versionMismatch", expected: error.expected, actual: error.actual };
		case "AgentProcessError":
		case "AgentProtocolError":
			return { status: "unknown", message: error.message };
	}
};

const fromAuthStatus = (auth: AgentAuthStatus): AgentAvailability => {
	switch (auth.status) {
		case "loggedIn":
			return { status: "ready", account: auth.account };
		case "loggedOut":
			return { status: "loggedOut" };
		case "unknown":
			return { status: "unknown", message: "Swarm could not read its sign-in status." };
	}
};

const toUnavailable = (agent: AgentKind) => (error: AgentError) =>
	new AgentUnavailableError({ agent, availability: toAvailability(error) });

const decodeEvent = Schema.decodeUnknownEffect(AgentEvent);

export class SessionService extends Context.Service<SessionService>()("swarm/daemon/sessions/SessionService", {
	make: Effect.gen(function* () {
		const database = yield* LocalDatabase;
		const credentials = yield* CredentialStore;
		const adapters: Record<AgentKind, AgentAdapter> = {
			claude: yield* ClaudeAdapter,
			codex: yield* CodexAdapter,
		};
		const services = yield* Effect.context<SecureRandom.SecureRandom>();
		const events = yield* PubSub.unbounded<Published>();
		const sessionChanges = yield* PubSub.unbounded<AgentSession>();
		// Insertion order is least recently used first, which picks the process to stop at the cap.
		const runtimes = new Map<string, Runtime>();
		// Starting and stopping processes one at a time keeps the cap exact.
		const processLock = yield* Semaphore.make(1);
		// Event consumers live here. Its finalizer runs after the shutdown finalizer below,
		// so consumers can still store the last events of the processes being stopped.
		const consumers = yield* Scope.fork(yield* Effect.scope);

		const getRow = Effect.fn("SessionService.getRow")(function* (sessionId: string) {
			const [row] = yield* database.query((db) => db.select().from(agentSession).where(eq(agentSession.id, sessionId)));
			if (row === undefined) {
				return yield* new SessionNotFoundError({ sessionId });
			}
			return row;
		});

		const updateSession = Effect.fnUntraced(function* (
			sessionId: string,
			patch: Partial<Pick<SessionRow, "status" | "nativeSessionId" | "authMode" | "title">>,
		) {
			const updatedAt = yield* nowIso;
			const [row] = yield* database.query((db) =>
				db
					.update(agentSession)
					.set({ ...patch, updatedAt })
					.where(eq(agentSession.id, sessionId))
					.returning(),
			);
			if (row === undefined) return undefined;
			const session = new AgentSession(row);
			yield* PubSub.publish(sessionChanges, session);
			return session;
		});

		const refreshStatus = (runtime: Runtime) => {
			const status = statusOf(runtime);
			if (status === runtime.status) return Effect.void;
			// Set before the write so concurrent callers write in the order they decided.
			runtime.status = status;
			return Effect.asVoid(updateSession(runtime.sessionId, { status }));
		};

		const publish = (event: SessionEvent) =>
			PubSub.publish(events, { event, bytes: JSON.stringify(event.event).length });

		// Stored events are written before they are published, so a subscriber never misses one.
		const record = Effect.fnUntraced(function* (runtime: Runtime, event: AgentEvent) {
			const { sessionId } = runtime;
			const createdAt = yield* nowIso;
			if (event.type === "message.delta") {
				return yield* publish(new SessionEvent({ sessionId, sequence: null, event, createdAt }));
			}
			const sequence = runtime.nextSequence;
			const id = yield* newId;
			yield* database.query((db) =>
				db.insert(sessionEvent).values({ id, sessionId, sequence, type: event.type, payload: event, createdAt }),
			);
			runtime.nextSequence++;
			yield* publish(new SessionEvent({ sessionId, sequence, event, createdAt }));
			switch (event.type) {
				case "session.started":
					yield* updateSession(sessionId, { nativeSessionId: event.nativeSessionId });
					break;
				case "approval.requested":
					runtime.approvals.add(event.requestId);
					break;
				case "approval.resolved":
					runtime.approvals.delete(event.requestId);
					break;
				case "turn.completed":
					runtime.outstanding = Math.max(0, runtime.outstanding - 1);
					runtime.resting = event.result.status === "interrupted" ? "interrupted" : "idle";
					break;
			}
			yield* refreshStatus(runtime);
		}, Effect.provide(services));

		const consume = Effect.fnUntraced(
			function* (runtime: Runtime) {
				const outcome = yield* runtime.handle.events.pipe(
					Stream.runForEach((event) => record(runtime, event)),
					Effect.result,
				);
				if (runtimes.get(runtime.sessionId) === runtime) runtimes.delete(runtime.sessionId);
				yield* Scope.close(runtime.scope, Exit.void);
				runtime.approvals.clear();
				runtime.outstanding = 0;
				if (Result.isSuccess(outcome)) {
					// The process ended, either stopped by us or on its own.
					if (isBusy(runtime.status)) runtime.resting = "interrupted";
				} else if (outcome.failure._tag === "LocalDatabaseError") {
					yield* Effect.logError("Could not store a session event", outcome.failure);
					runtime.resting = "failed";
				} else {
					const error = outcome.failure;
					yield* Effect.logError("Agent session failed", error).pipe(
						Effect.annotateLogs({ sessionId: runtime.sessionId }),
					);
					const message =
						error._tag === "AgentProcessError" || error._tag === "AgentProtocolError"
							? error.message
							: toUnavailable(runtime.agent)(error).message;
					yield* record(runtime, { type: "error", message, willRetry: false });
					runtime.resting = "failed";
				}
				yield* refreshStatus(runtime);
			},
			(effect, runtime) =>
				effect.pipe(
					Effect.catch((error) => Effect.logError("Could not finish an agent session", error)),
					Effect.ensuring(Deferred.succeed(runtime.done, undefined)),
				),
		);

		// Callers hold processLock.
		const stopRuntime = Effect.fnUntraced(function* (runtime: Runtime) {
			runtimes.delete(runtime.sessionId);
			if (isBusy(runtime.status)) {
				// Cancels pending approvals and records the interrupted turn before the process goes.
				yield* runtime.handle.interrupt.pipe(
					Effect.timeoutOption(STOP_GRACE),
					Effect.catch((error) => Effect.logWarning("Could not interrupt the agent before stopping it", error)),
				);
			}
			yield* Scope.close(runtime.scope, Exit.void);
			yield* Deferred.await(runtime.done);
		});

		const makeRoom = Effect.gen(function* () {
			if (runtimes.size < MAX_RUNNING_SESSIONS) return;
			const idle = [...runtimes.values()].find((runtime) => !isBusy(runtime.status));
			if (idle === undefined) {
				return yield* new SessionLimitReachedError({ limit: MAX_RUNNING_SESSIONS });
			}
			// An idle process resumes through its native id on the next message, so stopping it loses nothing.
			yield* Effect.logInfo("Stopping the least recently used idle agent").pipe(
				Effect.annotateLogs({ sessionId: idle.sessionId }),
			);
			yield* stopRuntime(idle);
		});

		const authFor = Effect.fnUntraced(function* (agent: AgentKind) {
			const apiKey = yield* credentials.get(agent);
			if (Option.isSome(apiKey)) {
				return { mode: "apiKey", apiKey: apiKey.value } satisfies StartSessionInput["auth"];
			}
			if (authModeFor(agent, false) === "apiKey") {
				return yield* new AgentUnavailableError({ agent, availability: { status: "needsApiKey" } });
			}
			return { mode: "subscription" } satisfies StartSessionInput["auth"];
		});

		const startRuntime = Effect.fnUntraced(function* (row: SessionRow) {
			const auth = yield* authFor(row.agent);
			yield* makeRoom;
			const [target] = yield* database.query((db) =>
				db
					.select({ path: workspace.path, trusted: project.trusted })
					.from(workspace)
					.innerJoin(project, eq(workspace.projectId, project.id))
					.where(eq(workspace.id, row.workspaceId)),
			);
			// The foreign key keeps the workspace while the session exists.
			if (target === undefined) return yield* Effect.die("The session's workspace is missing");
			const scope = yield* Scope.make();
			const handle = yield* adapters[row.agent]
				.startSession({
					cwd: target.path,
					model: row.model,
					trustProjectSettings: target.trusted,
					auth,
					...(row.nativeSessionId === null ? {} : { resumeId: row.nativeSessionId }),
				})
				.pipe(
					Scope.provide(scope),
					Effect.onError(() => Scope.close(scope, Exit.void)),
					Effect.mapError(toUnavailable(row.agent)),
				);
			const [stored] = yield* database.query((db) =>
				db
					.select({ last: max(sessionEvent.sequence) })
					.from(sessionEvent)
					.where(eq(sessionEvent.sessionId, row.id)),
			);
			const runtime: Runtime = {
				sessionId: row.id,
				workspaceId: row.workspaceId,
				agent: row.agent,
				handle,
				scope,
				done: yield* Deferred.make<void>(),
				nextSequence: (stored?.last ?? -1) + 1,
				outstanding: 0,
				approvals: new Set(),
				resting: isBusy(row.status) ? "idle" : row.status,
				status: row.status,
			};
			if (row.authMode !== auth.mode) {
				yield* updateSession(row.id, { authMode: auth.mode });
			}
			runtimes.set(row.id, runtime);
			yield* consume(runtime).pipe(Effect.forkIn(consumers));
			yield* Effect.logInfo("Started agent process").pipe(
				Effect.annotateLogs({ sessionId: row.id, agent: row.agent, resumed: row.nativeSessionId !== null }),
			);
			return runtime;
		});

		const ensureRuntime = (sessionId: string) =>
			Effect.gen(function* () {
				const existing = runtimes.get(sessionId);
				if (existing !== undefined) return existing;
				return yield* startRuntime(yield* getRow(sessionId));
			}).pipe(Semaphore.withPermit(processLock));

		const sendMessage = Effect.fn("SessionService.sendMessage")(function* (
			sessionId: string,
			text: string,
			steer: boolean,
		) {
			const runtime = yield* ensureRuntime(sessionId);
			if (runtimes.get(sessionId) === runtime) {
				runtimes.delete(sessionId);
				runtimes.set(sessionId, runtime);
			}
			// Counted before sending, so the turn's own completion can never arrive first.
			runtime.outstanding++;
			yield* refreshStatus(runtime);
			const sent = yield* runtime.handle.sendMessage(text, { steer }).pipe(
				Effect.mapError((error) => (error._tag === "SessionBusyError" ? error : toUnavailable(runtime.agent)(error))),
				Effect.tapError(() =>
					Effect.suspend(() => {
						runtime.outstanding--;
						return refreshStatus(runtime);
					}),
				),
			);
			if (sent === "steered") {
				runtime.outstanding--;
				yield* refreshStatus(runtime);
			}
		});

		const respondToApproval = Effect.fn("SessionService.respondToApproval")(function* (
			sessionId: string,
			requestId: string,
			decision: ApprovalDecision,
		) {
			const runtime = runtimes.get(sessionId);
			if (runtime === undefined) {
				yield* getRow(sessionId);
				return yield* new ApprovalNotFoundError({ requestId });
			}
			yield* runtime.handle.respondToApproval(requestId, decision);
		});

		const interrupt = Effect.fn("SessionService.interrupt")(function* (sessionId: string) {
			const runtime = runtimes.get(sessionId);
			if (runtime === undefined) {
				yield* getRow(sessionId);
				return;
			}
			yield* runtime.handle.interrupt;
		});

		const stop = Effect.fn("SessionService.stop")(function* (sessionId: string) {
			const runtime = runtimes.get(sessionId);
			if (runtime === undefined) {
				yield* getRow(sessionId);
				return;
			}
			yield* stopRuntime(runtime);
		}, Semaphore.withPermit(processLock));

		// Archiving a workspace releases every agent process in it.
		const stopWorkspace = Effect.fn("SessionService.stopWorkspace")(function* (workspaceId: string) {
			for (const runtime of [...runtimes.values()]) {
				if (runtime.workspaceId === workspaceId) yield* stopRuntime(runtime);
			}
		}, Semaphore.withPermit(processLock));

		const create = Effect.fn("SessionService.create")(function* (input: {
			readonly workspaceId: string;
			readonly agent: AgentKind;
			readonly model: string;
			readonly effort: string | null;
		}) {
			const found = yield* database.query((db) =>
				db.$count(workspace, and(eq(workspace.id, input.workspaceId), eq(workspace.status, "active"))),
			);
			if (found === 0) {
				return yield* new WorkspaceNotFoundError({ workspaceId: input.workspaceId });
			}
			const hasApiKey = Option.isSome(yield* credentials.get(input.agent));
			const now = yield* nowIso;
			const row: SessionRow = {
				id: yield* newId,
				...input,
				nativeSessionId: null,
				authMode: authModeFor(input.agent, hasApiKey),
				status: "idle",
				title: null,
				createdAt: now,
				updatedAt: now,
			};
			yield* database.query((db) => db.insert(agentSession).values(row));
			const session = new AgentSession(row);
			yield* PubSub.publish(sessionChanges, session);
			return session;
		}, Effect.provide(services));

		const list = (workspaceId: string) =>
			database
				.query((db) =>
					db
						.select()
						.from(agentSession)
						.where(eq(agentSession.workspaceId, workspaceId))
						.orderBy(asc(agentSession.createdAt)),
				)
				.pipe(Effect.map((rows) => rows.map((row) => new AgentSession(row))));

		const rename = Effect.fn("SessionService.rename")(function* (sessionId: string, title: string) {
			const session = yield* updateSession(sessionId, { title: title.trim() || null });
			if (session === undefined) {
				return yield* new SessionNotFoundError({ sessionId });
			}
			return session;
		});

		const historyPage = (sessionId: string, afterSequence: number) =>
			database
				.query((db) =>
					db
						.select()
						.from(sessionEvent)
						.where(and(eq(sessionEvent.sessionId, sessionId), gt(sessionEvent.sequence, afterSequence)))
						.orderBy(asc(sessionEvent.sequence))
						.limit(HISTORY_PAGE_SIZE),
				)
				.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) =>
							// A row that no longer decodes means a corrupt database, not a user error.
							Effect.map(
								Effect.orDie(decodeEvent(row.payload)),
								(event) => new SessionEvent({ sessionId, sequence: row.sequence, event, createdAt: row.createdAt }),
							),
						).pipe(
							Effect.map(
								(page) =>
									[
										page,
										rows.length === HISTORY_PAGE_SIZE
											? Option.some(rows[rows.length - 1]?.sequence ?? afterSequence)
											: Option.none<number>(),
									] as const,
							),
						),
					),
				);

		// Live events are buffered from the start, then stored history is paged, then the buffer
		// drains with already-sent sequences skipped. That leaves no gap and no duplicate.
		const subscribe = (sessionId: string, afterSequence: number) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* getRow(sessionId);
					const subscription = yield* PubSub.subscribe(events);
					const buffer = yield* Queue.unbounded<Published, ResubscribeRequiredError | Cause.Done>();
					let bufferedBytes = 0;
					let lastSequence = afterSequence;

					yield* PubSub.take(subscription).pipe(
						Effect.flatMap((published) => {
							if (published.event.sessionId !== sessionId) return Effect.succeed(true);
							const full =
								Queue.sizeUnsafe(buffer) >= SUBSCRIBER_MAX_EVENTS ||
								bufferedBytes + published.bytes > SUBSCRIBER_MAX_BYTES;
							if (full) {
								// The stream below replaces lastSequence with what the client actually got.
								return Effect.as(Queue.fail(buffer, new ResubscribeRequiredError({ lastSequence })), false);
							}
							bufferedBytes += published.bytes;
							return Queue.offer(buffer, published);
						}),
						Effect.repeat({ while: (keepGoing) => keepGoing }),
						Effect.forkScoped,
					);

					const history = Stream.paginate(afterSequence, (cursor) => historyPage(sessionId, cursor));
					const live = Stream.fromQueue(buffer).pipe(
						Stream.map((published) => {
							bufferedBytes -= published.bytes;
							return published.event;
						}),
					);
					return Stream.concat(history, live).pipe(
						Stream.filter((event) => {
							if (event.sequence === null) return true;
							if (event.sequence <= lastSequence) return false;
							lastSequence = event.sequence;
							return true;
						}),
						Stream.catchTag("ResubscribeRequiredError", () =>
							Stream.fail(new ResubscribeRequiredError({ lastSequence })),
						),
					);
				}),
			);

		const watch = Stream.fromPubSub(sessionChanges);

		const agentInfo = Effect.fnUntraced(function* (kind: AgentKind) {
			const adapter = adapters[kind];
			const hasApiKey = Option.isSome(yield* credentials.get(kind));
			const listed = yield* Effect.result(adapter.listModels);
			if (Result.isFailure(listed)) {
				yield* Effect.logWarning("Could not list agent models, showing none", listed.failure).pipe(
					Effect.annotateLogs({ agent: kind }),
				);
			}
			const availability: AgentAvailability = Result.isFailure(listed)
				? toAvailability(listed.failure)
				: authModeFor(kind, hasApiKey) === "apiKey"
					? hasApiKey
						? { status: "ready", account: null }
						: { status: "needsApiKey" }
					: yield* adapter.checkAuth.pipe(
							Effect.map(fromAuthStatus),
							Effect.catch((error) => Effect.succeed(toAvailability(error))),
						);
			return new AgentInfo({
				kind,
				availability,
				capabilities: adapter.capabilities,
				authModes: kind === "claude" ? ["apiKey"] : ["apiKey", "subscription"],
				authMode: authModeFor(kind, hasApiKey),
				...(Result.isSuccess(listed) ? listed.success : { models: [], defaultModel: "" }),
			});
		});

		const listAgents = Effect.forEach(["claude", "codex"] as const, agentInfo, { concurrency: "unbounded" }).pipe(
			Effect.withSpan("SessionService.listAgents"),
		);

		const setApiKey = (agent: AgentKind, apiKey: Redacted.Redacted<string>) => credentials.set(agent, apiKey);
		const removeApiKey = (agent: AgentKind) => credentials.remove(agent);

		// Startup recovery: a restart cut off every turn that was running or waiting for an approval.
		const recoverSessions = Effect.gen(function* () {
			const updatedAt = yield* nowIso;
			const cutOff = yield* database.query((db) =>
				db
					.update(agentSession)
					.set({ status: "interrupted", updatedAt })
					.where(inArray(agentSession.status, ["running", "awaitingApproval"]))
					.returning({ id: agentSession.id }),
			);
			if (cutOff.length > 0) {
				yield* Effect.logInfo("Marked sessions cut off by a restart as interrupted").pipe(
					Effect.annotateLogs({ count: cutOff.length }),
				);
			}
		});
		yield* recoverSessions;

		yield* Effect.addFinalizer(() =>
			Effect.forEach([...runtimes.values()], stopRuntime, { discard: true }).pipe(Semaphore.withPermit(processLock)),
		);

		return {
			listAgents,
			setApiKey,
			removeApiKey,
			create,
			list,
			rename,
			sendMessage,
			respondToApproval,
			interrupt,
			stop,
			stopWorkspace,
			subscribe,
			watch,
		};
	}),
}) {
	static readonly layer = Layer.effect(SessionService, SessionService.make);
}
