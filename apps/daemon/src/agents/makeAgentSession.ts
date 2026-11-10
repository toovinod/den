import {
	type AgentError,
	type AgentSessionHandle,
	ApprovalChoiceError,
	type SessionSettings,
	type UserMessage,
} from "./AgentAdapter.ts";
import { type AgentCapabilities, ApprovalNotFoundError, SessionBusyError } from "@repo/contracts/AgentSession";
import { type Cause, Deferred, Effect, Option, Queue, Ref, type Scope, Semaphore, Stream } from "effect";
import type { AgentEvent, ApprovalDecision, ApprovalOutcome } from "@repo/contracts/AgentEvent";

// Events wait here until the consumer reads them. A full buffer slows the agent reader
// down instead of growing memory.
const EVENT_BUFFER = 256;
export const MAX_QUEUED_MESSAGES = 8;

type ApprovalRequest = Omit<Extract<AgentEvent, { type: "approval.requested" }>, "type">;

type RespondToAgent = (outcome: ApprovalOutcome) => Effect.Effect<void, AgentError>;

// What each adapter does to drive its agent. The session below owns everything else:
// the event buffer, turn queue, pending approvals and the native id.
export interface TurnDriver {
	startTurn(message: UserMessage): Effect.Effect<void, AgentError>;
	steerTurn(message: UserMessage): Effect.Effect<void, AgentError>;
	readonly interruptTurn: Effect.Effect<void, AgentError>;
	updateSettings(settings: SessionSettings): Effect.Effect<void, AgentError>;
}

export interface AgentSession {
	emit(event: AgentEvent): Effect.Effect<void>;
	requestApproval(request: ApprovalRequest, respond: RespondToAgent): Effect.Effect<void>;
	setNativeSessionId(id: string): Effect.Effect<void>;
	readonly nativeSessionId: Effect.Effect<string, AgentError>;
	fail(error: AgentError): Effect.Effect<void>;
	readonly end: Effect.Effect<void>;
	start(driver: TurnDriver): Effect.Effect<AgentSessionHandle, never, Scope.Scope>;
}

export const makeAgentSession = Effect.fnUntraced(function* (capabilities: AgentCapabilities) {
	const events = yield* Queue.bounded<AgentEvent, AgentError | Cause.Done>(EVENT_BUFFER);
	yield* Effect.addFinalizer(() => Queue.end(events));
	const nativeId = yield* Deferred.make<string, AgentError>();
	const inbox = yield* Queue.bounded<UserMessage>(MAX_QUEUED_MESSAGES);
	// Checking room, storing the message and queueing it happen as one step, so history order matches.
	const sendLock = yield* Semaphore.make(1);
	const currentTurn = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
	const approvals = new Map<
		string,
		{
			readonly choices: ReadonlyArray<ApprovalDecision>;
			readonly respond: RespondToAgent;
		}
	>();

	const emit = (event: AgentEvent) =>
		Effect.gen(function* () {
			yield* Queue.offer(events, event);
			if (event.type === "turn.completed") {
				const turn = yield* Ref.get(currentTurn);
				if (Option.isSome(turn)) yield* Deferred.succeed(turn.value, undefined);
			}
		});

	const fail = (error: AgentError) =>
		Effect.gen(function* () {
			yield* Deferred.fail(nativeId, error);
			yield* Queue.fail(events, error);
		});

	const resolve = (requestId: string, outcome: ApprovalOutcome) =>
		emit({ type: "approval.resolved", requestId, outcome });

	const cancelApprovals = Effect.gen(function* () {
		const pending = [...approvals.entries()];
		approvals.clear();
		for (const [requestId, approval] of pending) {
			yield* resolve(requestId, "cancelled");
			yield* approval.respond("cancelled");
		}
	});

	const start = (driver: TurnDriver) =>
		Effect.gen(function* () {
			yield* Effect.gen(function* () {
				const message = yield* Queue.take(inbox);
				const done = yield* Deferred.make<void>();
				yield* Ref.set(currentTurn, Option.some(done));
				// A rejected turn fails only that turn. Process failures still end the session.
				yield* driver.startTurn(message).pipe(
					Effect.catchTag("AgentProtocolError", (error) =>
						emit({
							type: "turn.completed",
							turnId: "notStarted",
							result: { status: "failed", message: error.message },
						}),
					),
				);
				yield* Deferred.await(done);
				yield* Ref.set(currentTurn, Option.none());
			}).pipe(Effect.forever, Effect.catch(fail), Effect.forkScoped);

			return {
				nativeSessionId: Deferred.await(nativeId),
				events: Stream.fromQueue(events),
				sendMessage: (message, options) =>
					Effect.gen(function* () {
						const running = Option.isSome(yield* Ref.get(currentTurn));
						const steer = options?.steer && capabilities.steerWhileRunning && running;
						if (!steer && Queue.sizeUnsafe(inbox) >= MAX_QUEUED_MESSAGES) {
							return yield* new SessionBusyError({ queued: MAX_QUEUED_MESSAGES });
						}
						const recordMessage = emit({
							type: "user.message",
							itemId: message.id,
							text: message.text,
							attachments: message.images.map(({ id, mediaType }) => ({ id, mediaType })),
						});
						if (steer) {
							// Recorded only once the agent took it, so a rejected steer leaves no message in history
							// that the agent never saw, and the caller can safely drop its images.
							yield* driver.steerTurn(message);
							yield* recordMessage;
							return "steered" as const;
						}
						yield* recordMessage;
						Queue.offerUnsafe(inbox, message);
						return "queued" as const;
					}).pipe(Semaphore.withPermit(sendLock)),
				respondToApproval: (requestId, decision) =>
					Effect.gen(function* () {
						const approval = approvals.get(requestId);
						if (approval === undefined) {
							return yield* new ApprovalNotFoundError({ requestId });
						}
						if (!approval.choices.includes(decision)) {
							return yield* new ApprovalChoiceError({ requestId, decision });
						}
						approvals.delete(requestId);
						// Resolve before answering, so the agent's next events follow it.
						yield* resolve(requestId, decision);
						yield* approval.respond(decision);
					}),
				interrupt: Effect.gen(function* () {
					yield* cancelApprovals;
					if (Option.isSome(yield* Ref.get(currentTurn))) {
						yield* driver.interruptTurn;
					}
				}),
				updateSettings: driver.updateSettings,
			} satisfies AgentSessionHandle;
		});

	return {
		emit,
		requestApproval: (request, respond) =>
			Effect.gen(function* () {
				approvals.set(request.requestId, { choices: request.choices, respond });
				yield* emit({ type: "approval.requested", ...request });
			}),
		nativeSessionId: Deferred.await(nativeId),
		setNativeSessionId: (id) =>
			Effect.gen(function* () {
				if (yield* Deferred.succeed(nativeId, id)) {
					yield* emit({ type: "session.started", nativeSessionId: id });
				}
			}),
		fail,
		end: Effect.asVoid(Queue.end(events)),
		start,
	} satisfies AgentSession;
});
