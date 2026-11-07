import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@repo/contracts/AgentEvent";
import { Effect, Schema, Stream } from "effect";
import type { AgentSessionHandle } from "../AgentAdapter.ts";
import { MAX_QUEUED_MESSAGES } from "../makeAgentSession.ts";
import recordingJson from "./fixtures/commandWithApproval.json" with { type: "json" };
import { makeReplayAdapter, Recording } from "./ReplayAdapter.ts";

const recording = Schema.decodeUnknownSync(Recording)(recordingJson);
const input = {
	cwd: "/repo",
	model: "gpt-5",
	trustProjectSettings: false,
	auth: { mode: "subscription" },
} as const;

const takeUntil = (handle: AgentSessionHandle, type: AgentEvent["type"]) =>
	handle.events.pipe(
		Stream.takeUntil((event) => event.type === type),
		Stream.runCollect,
	);

const runSession = <A, E>(program: (handle: AgentSessionHandle) => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const handle = yield* makeReplayAdapter(recording).startSession(input);
		return yield* program(handle);
	}).pipe(Effect.scoped, Effect.runPromise);

describe("ReplayAdapter", () => {
	test("plays a turn and pauses on the approval until it is answered", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				expect(yield* handle.nativeSessionId).toBe("thread-replay");
				yield* handle.sendMessage("run the tests");
				const beforeApproval = yield* takeUntil(handle, "approval.requested");
				yield* handle.respondToApproval("0", "allowOnce");
				const afterApproval = yield* takeUntil(handle, "turn.completed");
				return [...beforeApproval, ...afterApproval].map((event) => event.type);
			}),
		);
		expect(events).toEqual([
			"session.started",
			"message.delta",
			"message.delta",
			"message.completed",
			"tool.started",
			"approval.requested",
			"approval.resolved",
			"tool.completed",
			"turn.completed",
		]);
	});

	test("rejects an approval id that is not pending", async () => {
		const error = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage("run the tests");
				yield* takeUntil(handle, "approval.requested");
				return yield* Effect.flip(handle.respondToApproval("missing", "deny"));
			}),
		);
		expect(error._tag).toBe("ApprovalNotFoundError");
	});

	test("queues messages during a turn and fails when the queue is full", async () => {
		const error = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage("run the tests");
				yield* takeUntil(handle, "approval.requested");
				for (let queued = 0; queued < MAX_QUEUED_MESSAGES; queued++) {
					yield* handle.sendMessage(`follow-up ${queued}`);
				}
				return yield* Effect.flip(handle.sendMessage("one too many"));
			}),
		);
		expect(error._tag).toBe("SessionBusyError");
	});

	test("interrupt cancels the pending approval, then stops the turn", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage("run the tests");
				yield* takeUntil(handle, "approval.requested");
				yield* handle.interrupt;
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events).toEqual([
			{ type: "approval.resolved", requestId: "0", outcome: "cancelled" },
			{
				type: "turn.completed",
				turnId: "replay-0",
				result: { status: "interrupted" },
			},
		]);
	});
});
