import { describe, expect, test } from "bun:test";
import type {
	CanUseTool,
	PermissionResult,
	PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { BunServices } from "@effect/platform-bun";
import type { AgentEvent } from "@repo/contracts/AgentEvent";
import { Effect, Layer, Stream } from "effect";
import type { AgentSessionHandle, StartSessionInput } from "../AgentAdapter.ts";
import { ClaudeAdapter, ClaudeAdapterConfig } from "./ClaudeAdapter.ts";
import { ClaudeQuery } from "./ClaudeQuery.ts";

const newSession: StartSessionInput = {
	cwd: "/repo",
	model: "claude-opus-4-5",
	auth: { mode: "subscription" },
};

const bashSuggestion: PermissionUpdate = {
	type: "addRules",
	rules: [{ toolName: "Bash", ruleContent: "bun test" }],
	behavior: "allow",
	destination: "session",
};

// A scripted stand-in for the SDK's query(). "approve" in a message asks for a Bash
// approval, and "session" adds a permission suggestion so allowForSession is offered.
const makeFakeQuery = (permissions: Array<PermissionResult>) =>
	ClaudeQuery.of({
		start: ({ prompt, options }) => {
			let resolveInterrupt = () => {};
			let turn = 0;
			async function* messages() {
				for await (const user of prompt) {
					turn++;
					const text =
						typeof user.message.content === "string"
							? user.message.content
							: "";
					if (turn === 1) {
						yield {
							type: "system",
							subtype: "init",
							session_id: options.resume ?? "claude-new",
						};
					}
					yield {
						type: "stream_event",
						parent_tool_use_id: null,
						event: { type: "message_start", message: { id: "msg_1" } },
					};
					yield {
						type: "stream_event",
						parent_tool_use_id: null,
						event: {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "Hi" },
						},
					};
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: { id: "msg_1", content: [{ type: "text", text: "Hi" }] },
					};
					if (text.includes("approve")) {
						const input = { command: "bun test" };
						yield {
							type: "assistant",
							parent_tool_use_id: null,
							message: {
								id: "msg_1",
								content: [
									{ type: "tool_use", id: "toolu_1", name: "Bash", input },
								],
							},
						};
						const interrupted = new Promise<void>((resolve) => {
							resolveInterrupt = resolve;
						});
						const request: Parameters<CanUseTool>[2] = {
							signal: new AbortController().signal,
							toolUseID: "toolu_1",
							requestId: "req_1",
							title: "Run bun test",
							suggestions: text.includes("session") ? [bashSuggestion] : [],
						};
						const permission = await options.canUseTool?.(
							"Bash",
							input,
							request,
						);
						if (!permission) return;
						permissions.push(permission);
						if (permission.behavior === "deny" && permission.interrupt) {
							await interrupted;
							yield {
								type: "result",
								subtype: "error_during_execution",
								uuid: `result-${turn}`,
							};
							continue;
						}
						yield {
							type: "user",
							parent_tool_use_id: null,
							message: {
								content: [
									{
										type: "tool_result",
										tool_use_id: "toolu_1",
										content: "3 pass",
									},
								],
							},
						};
					}
					yield { type: "result", subtype: "success", uuid: `result-${turn}` };
				}
			}
			return {
				messages: messages(),
				interrupt: async () => resolveInterrupt(),
				close: () => {},
			};
		},
	});

const runWithClaude = <A, E>(
	program: Effect.Effect<A, E, ClaudeAdapter>,
	permissions: Array<PermissionResult> = [],
) =>
	program.pipe(
		Effect.provide(
			ClaudeAdapter.layer.pipe(
				Layer.provide(Layer.succeed(ClaudeQuery, makeFakeQuery(permissions))),
				Layer.provide(BunServices.layer),
			),
		),
		Effect.provideService(ClaudeAdapterConfig, {
			executablePath: `${import.meta.dir}/fixtures/fakeClaude.ts`,
		}),
		Effect.runPromise,
	);

const runSession = <A, E>(
	program: (handle: AgentSessionHandle) => Effect.Effect<A, E>,
	options: {
		input?: StartSessionInput;
		permissions?: Array<PermissionResult>;
	} = {},
) =>
	runWithClaude(
		Effect.gen(function* () {
			const claude = yield* ClaudeAdapter;
			return yield* program(
				yield* claude.startSession(options.input ?? newSession),
			);
		}).pipe(Effect.scoped),
		options.permissions,
	);

const takeUntil = (handle: AgentSessionHandle, type: AgentEvent["type"]) =>
	handle.events.pipe(
		Stream.takeUntil((event) => event.type === type),
		Stream.runCollect,
	);

describe("ClaudeAdapter", () => {
	test("reports the login from claude auth status", async () => {
		const status = await runWithClaude(
			Effect.gen(function* () {
				const claude = yield* ClaudeAdapter;
				return yield* claude.checkAuth;
			}),
		);
		expect(status).toEqual({ status: "loggedIn", account: "dev@example.com" });
	});

	test("maps SDK messages and learns the session id from the first turn", async () => {
		const [id, events] = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage("hi");
				const id = yield* handle.nativeSessionId;
				return [id, yield* takeUntil(handle, "turn.completed")] as const;
			}),
		);
		expect(id).toBe("claude-new");
		expect(events).toEqual([
			{ type: "session.started", nativeSessionId: "claude-new" },
			{ type: "message.delta", itemId: "msg_1:0", text: "Hi" },
			{ type: "message.completed", itemId: "msg_1:0", text: "Hi" },
			{
				type: "turn.completed",
				turnId: "result-1",
				result: { status: "completed" },
			},
		]);
	});

	test("round-trips an approval and allows it for the session", async () => {
		const permissions: Array<PermissionResult> = [];
		const [requested, rest] = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage("approve for the session");
					const before = yield* takeUntil(handle, "approval.requested");
					yield* handle.respondToApproval("toolu_1", "allowForSession");
					return [before.slice(-2), yield* takeUntil(handle, "turn.completed")];
				}),
			{ permissions },
		);
		expect(requested).toEqual([
			{
				type: "tool.started",
				itemId: "toolu_1",
				tool: { kind: "command", command: "bun test", cwd: null },
			},
			{
				type: "approval.requested",
				requestId: "toolu_1",
				itemId: "toolu_1",
				kind: "command",
				summary: "Run bun test",
				reason: null,
				choices: ["allowOnce", "allowForSession", "deny"],
			},
		]);
		expect(rest).toEqual([
			{
				type: "approval.resolved",
				requestId: "toolu_1",
				outcome: "allowForSession",
			},
			{
				type: "tool.completed",
				itemId: "toolu_1",
				tool: { kind: "command", command: "bun test", cwd: null },
				status: "completed",
				output: "3 pass",
			},
			{
				type: "turn.completed",
				turnId: "result-1",
				result: { status: "completed" },
			},
		]);
		expect(permissions).toEqual([
			{
				behavior: "allow",
				updatedInput: { command: "bun test" },
				updatedPermissions: [bashSuggestion],
			},
		]);
	});

	test("rejects allowForSession when the SDK offers no session rule", async () => {
		const error = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage("approve");
				yield* takeUntil(handle, "approval.requested");
				return yield* Effect.flip(
					handle.respondToApproval("toolu_1", "allowForSession"),
				);
			}),
		);
		expect(error._tag).toBe("ApprovalChoiceError");
	});

	test("interrupt denies the pending approval, then interrupts the query", async () => {
		const permissions: Array<PermissionResult> = [];
		const events = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage("approve");
					yield* takeUntil(handle, "approval.requested");
					yield* handle.interrupt;
					return yield* takeUntil(handle, "turn.completed");
				}),
			{ permissions },
		);
		expect(events).toEqual([
			{ type: "approval.resolved", requestId: "toolu_1", outcome: "cancelled" },
			{
				type: "turn.completed",
				turnId: "result-1",
				result: { status: "interrupted" },
			},
		]);
		expect(permissions).toMatchObject([{ behavior: "deny", interrupt: true }]);
	});

	test("resumes an existing session", async () => {
		const id = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage("hi");
					return yield* handle.nativeSessionId;
				}),
			{ input: { ...newSession, resumeId: "claude-old" } },
		);
		expect(id).toBe("claude-old");
	});
});
