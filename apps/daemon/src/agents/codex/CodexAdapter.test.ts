import { CODEX_VERSION, CodexAdapter, CodexAdapterConfig } from "./CodexAdapter.ts";
import type { AgentSessionHandle, StartSessionInput } from "../AgentAdapter.ts";
import type { AgentEvent } from "@repo/contracts/AgentEvent";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";

const fakeCodex = `${import.meta.dir}/fixtures/fakeCodex.ts`;
const newSession: StartSessionInput = {
	cwd: import.meta.dir,
	model: "gpt-5",
	trustProjectSettings: false,
	auth: { mode: "subscription" },
};

const runWithCodex = <A, E>(program: Effect.Effect<A, E, CodexAdapter>, executable = fakeCodex) =>
	program.pipe(
		Effect.provide(CodexAdapter.layer),
		Effect.provide(BunServices.layer),
		Effect.provideService(CodexAdapterConfig, { executable }),
		Effect.runPromise,
	);

const runSession = <A, E>(program: (handle: AgentSessionHandle) => Effect.Effect<A, E>, input = newSession) =>
	runWithCodex(
		Effect.gen(function* () {
			const codex = yield* CodexAdapter;
			return yield* program(yield* codex.startSession(input));
		}).pipe(Effect.scoped),
	);

const checkAuth = Effect.gen(function* () {
	const codex = yield* CodexAdapter;
	return yield* codex.checkAuth;
});

const takeUntil = (handle: AgentSessionHandle, type: AgentEvent["type"]) =>
	handle.events.pipe(
		Stream.takeUntil((event) => event.type === type),
		Stream.runCollect,
	);

describe("CodexAdapter", () => {
	test("reports the login from account/read", async () => {
		const status = await runWithCodex(checkAuth);
		expect(status).toEqual({ status: "loggedIn", account: "dev@example.com" });
	});

	test("streams a turn with deltas", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage("hi");
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events).toEqual([
			{ type: "session.started", nativeSessionId: "thread-new" },
			{ type: "message.delta", itemId: "msg-1", text: "Hel" },
			{ type: "message.delta", itemId: "msg-1", text: "lo" },
			{ type: "message.completed", itemId: "msg-1", text: "Hello" },
			{
				type: "turn.completed",
				turnId: "turn-1",
				result: { status: "completed" },
			},
		]);
	});

	test("round-trips a command approval", async () => {
		const [requested, rest] = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage("approve this");
				const before = yield* takeUntil(handle, "approval.requested");
				yield* handle.respondToApproval("100", "allowOnce");
				return [before.at(-1), yield* takeUntil(handle, "turn.completed")];
			}),
		);
		expect(requested).toEqual({
			type: "approval.requested",
			requestId: "100",
			itemId: "cmd-1",
			kind: "command",
			summary: "bun test",
			reason: "Run the tests",
			choices: ["allowOnce", "allowForSession", "deny"],
		});
		expect(rest).toEqual([
			{ type: "approval.resolved", requestId: "100", outcome: "allowOnce" },
			{
				type: "tool.completed",
				itemId: "cmd-1",
				tool: { kind: "command", command: "bun test", cwd: "/repo" },
				status: "completed",
				output: "3 pass",
			},
			{
				type: "turn.completed",
				turnId: "turn-1",
				result: { status: "completed" },
			},
		]);
	});

	test("interrupt cancels a pending approval, then interrupts the turn", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage("approve this");
				yield* takeUntil(handle, "approval.requested");
				yield* handle.interrupt;
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events).toEqual([
			{ type: "approval.resolved", requestId: "100", outcome: "cancelled" },
			{
				type: "turn.completed",
				turnId: "turn-1",
				result: { status: "interrupted" },
			},
		]);
	});

	test("resumes an existing thread", async () => {
		const id = await runSession((handle) => handle.nativeSessionId, {
			...newSession,
			resumeId: "thread-old",
		});
		expect(id).toBe("thread-old");
	});

	test("declines unsupported server requests with method not found", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage("ask me");
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.map((event) => event.type)).toEqual([
			"session.started",
			"error",
			"message.completed",
			"turn.completed",
		]);
		expect(events[2]).toMatchObject({ text: "error -32601" });
	});

	test("fails when the installed version differs from the generated types", async () => {
		const error = await runWithCodex(Effect.flip(checkAuth), `${import.meta.dir}/fixtures/outdatedCodex.ts`);
		expect(error).toMatchObject({
			_tag: "CodexVersionMismatchError",
			actual: "0.0.1",
		});
		expect(error.message).toBe(
			`Swarm needs Codex ${CODEX_VERSION}, but the installed codex is 0.0.1. Install Codex ${CODEX_VERSION} to use it with Swarm.`,
		);
	});

	test("reports a missing executable as not installed", async () => {
		const error = await runWithCodex(Effect.flip(checkAuth), "/nonexistent/codex");
		expect(error._tag).toBe("AgentNotInstalledError");
		expect(error.message).toBe(
			"Swarm could not find /nonexistent/codex. Install it, or add its folder to the PATH your login shell sets.",
		);
	});
});
