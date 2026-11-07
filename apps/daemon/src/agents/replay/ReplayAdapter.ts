import { type AgentCapabilities, AgentKind } from "@repo/contracts/AgentSession";
import { AgentEvent, type ApprovalOutcome } from "@repo/contracts/AgentEvent";
import { Deferred, Effect, FiberHandle, Ref, Schema } from "effect";
import { makeAgentSession } from "../makeAgentSession.ts";
import type { AgentAdapter } from "../AgentAdapter.ts";

export const Recording = Schema.Struct({
	kind: AgentKind,
	nativeSessionId: Schema.String,
	turns: Schema.Array(Schema.Array(AgentEvent)),
});
export type Recording = typeof Recording.Type;

const capabilities: AgentCapabilities = {
	resume: true,
	interrupt: true,
	fileChangeApprovals: true,
	mcpApprovals: true,
	steerWhileRunning: false,
};

// Approval requests pause playback until they are answered. The session core emits
// session.started and approval.resolved itself, so recorded copies of those are skipped.
export const makeReplayAdapter = (recording: Recording): AgentAdapter => ({
	kind: recording.kind,
	capabilities,
	checkAuth: Effect.succeed({ status: "loggedIn", account: null }),
	listModels: Effect.succeed({
		models: [
			{
				id: "replay",
				label: "Replay",
				description: "",
				efforts: ["low", "high"],
				defaultEffort: "low",
				contextWindow: null,
				supportsImages: true,
			},
		],
		defaultModel: "replay",
	}),
	startSession: Effect.fn("ReplayAdapter.startSession")(function* () {
		const session = yield* makeAgentSession(capabilities);
		const nextTurn = yield* Ref.make(0);
		const playback = yield* FiberHandle.make();

		const play = (event: AgentEvent) =>
			Effect.gen(function* () {
				if (event.type === "approval.requested") {
					const answered = yield* Deferred.make<ApprovalOutcome>();
					const { type: _, ...request } = event;
					yield* session.requestApproval(request, (outcome) => Deferred.succeed(answered, outcome));
					// A cancelled approval means the turn is being interrupted, so playback stops.
					if ((yield* Deferred.await(answered)) === "cancelled") {
						return yield* Effect.interrupt;
					}
				} else if (event.type !== "session.started" && event.type !== "approval.resolved") {
					yield* session.emit(event);
				}
			});

		yield* session.setNativeSessionId(recording.nativeSessionId);
		return yield* session.start({
			startTurn: () =>
				Effect.gen(function* () {
					const index = yield* Ref.getAndUpdate(nextTurn, (n) => n + 1);
					const turn = recording.turns[index];
					if (turn === undefined) {
						return yield* session.emit({
							type: "turn.completed",
							turnId: `replay-${index}`,
							result: {
								status: "failed",
								message: "The recording has no more turns.",
							},
						});
					}
					yield* FiberHandle.run(playback, Effect.forEach(turn, play, { discard: true }));
				}),
			steerTurn: () => Effect.void,
			interruptTurn: Effect.gen(function* () {
				yield* FiberHandle.clear(playback);
				const index = (yield* Ref.get(nextTurn)) - 1;
				yield* session.emit({
					type: "turn.completed",
					turnId: `replay-${index}`,
					result: { status: "interrupted" },
				});
			}),
		});
	}),
});
