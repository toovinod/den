import type { AgentEvent } from "@repo/contracts/AgentEvent";
import { applyEvents, emptyChat } from "./chatReducer.ts";
import { describe, expect, test } from "bun:test";

let nextSequence = 0;
const stored = (event: AgentEvent) => ({ sessionId: "s", sequence: nextSequence++, event, createdAt: "" });
const live = (event: AgentEvent) => ({ sessionId: "s", sequence: null, event, createdAt: "" });

const command = { kind: "command", command: "bun test", cwd: "/repo" } as const;

describe("applyEvents", () => {
	test("streams a reply, runs a tool behind an approval and records usage", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [
			stored({ type: "user.message", itemId: "u1", text: "Run the tests", attachments: [] }),
			live({ type: "message.delta", itemId: "m1", text: "Running " }),
			live({ type: "message.delta", itemId: "m1", text: "the tests." }),
			stored({ type: "tool.started", itemId: "c1", tool: command }),
			stored({
				type: "approval.requested",
				requestId: "r1",
				itemId: "c1",
				kind: "command",
				summary: "bun test",
				reason: null,
				choices: ["allowOnce", "deny"],
			}),
			stored({ type: "usage.updated", contextTokens: 1200, contextWindow: 200_000 }),
		]);
		expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "approval"]);
		expect(state.items[1]).toMatchObject({ text: "Running the tests.", streaming: true });
		expect(state.usage).toEqual({ contextTokens: 1200, contextWindow: 200_000 });

		const done = applyEvents(state, [
			stored({ type: "approval.resolved", requestId: "r1", outcome: "allowOnce" }),
			stored({ type: "tool.completed", itemId: "c1", tool: command, status: "completed", output: "3 pass" }),
			stored({ type: "turn.completed", turnId: "t1", result: { status: "completed" } }),
		]);
		expect(done.items[1]).toMatchObject({ streaming: false });
		expect(done.items[2]).toMatchObject({ kind: "tool", status: "completed", output: "3 pass" });
		expect(done.items[3]).toMatchObject({ kind: "approval", outcome: "allowOnce" });
		expect(done.lastSequence).toBe(6);
	});

	test("skips stored events it already holds after a resubscribe", () => {
		nextSequence = 0;
		const first = stored({ type: "message.completed", itemId: "m1", text: "Hi" });
		const state = applyEvents(emptyChat("s"), [first]);
		expect(applyEvents(state, [first]).items).toHaveLength(1);
	});

	test("shows interrupted and failed turns as notices", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [
			stored({ type: "turn.completed", turnId: "t1", result: { status: "interrupted" } }),
			stored({ type: "turn.completed", turnId: "t2", result: { status: "failed", message: "Out of credits" } }),
			stored({
				type: "rateLimit.updated",
				window: "5h",
				status: "warning",
				usedPercent: 80,
				resetsAt: null,
			}),
		]);
		expect(state.items).toEqual([
			{ kind: "notice", key: "turn:t1", tone: "warning", text: "Interrupted" },
			{ kind: "notice", key: "turn:t2", tone: "error", text: "Out of credits" },
		]);
		expect(state.rateLimit).toMatchObject({ status: "warning", usedPercent: 80 });
	});
});

describe("applyEvents positions", () => {
	test("reuses the positions map when a batch only updates existing items", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [live({ type: "message.delta", itemId: "m1", text: "Hel" })]);
		const next = applyEvents(state, [live({ type: "message.delta", itemId: "m1", text: "lo" })]);
		expect(next.positions).toBe(state.positions);
		expect(next.items[0]).toMatchObject({ text: "Hello" });
	});

	test("adds new items without changing the previous state's positions", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [live({ type: "message.delta", itemId: "m1", text: "Hi" })]);
		const next = applyEvents(state, [
			stored({ type: "tool.started", itemId: "c1", tool: command }),
			stored({ type: "tool.started", itemId: "c2", tool: command }),
		]);
		expect(state.positions).toEqual({ "message:m1": 0 });
		expect(next.positions).toEqual({ "message:m1": 0, "tool:c1": 1, "tool:c2": 2 });
	});
});
