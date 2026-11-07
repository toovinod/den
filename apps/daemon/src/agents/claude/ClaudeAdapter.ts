import {
	type AgentAdapter,
	type AgentAuthStatus,
	type AgentCapabilities,
	AgentNotInstalledError,
	AgentProcessError,
	AgentProtocolError,
	type StartSessionInput,
} from "../AgentAdapter.ts";
import type {
	CanUseTool,
	Options,
	PermissionResult,
	PermissionUpdate,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Config, Context, Deferred, Effect, Layer, Option, Queue, Redacted, Ref, Schema, Stream } from "effect";
import type { ApprovalDecision, ApprovalOutcome, ToolCall } from "@repo/contracts/AgentEvent";
import { BashInput, ClaudeAuthStatus, ClaudeMessage, FileInput } from "./claudeMessages.ts";
import { type AgentSession, makeAgentSession } from "../makeAgentSession.ts";
import { stopProcessGroup } from "../../processes/stopProcessGroup.ts";
import { ProcessRegistry } from "../../processes/ProcessRegistry.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { spawnInProcessGroup } from "./spawnInProcessGroup.ts";
import { keepOutputTail } from "../keepOutputTail.ts";
import { toAgentError } from "../toAgentError.ts";
import { ClaudeQuery } from "./ClaudeQuery.ts";

// Swarm runs the user's own `claude`, found on PATH unless this names another one. Inside a
// `bun build --compile` binary the SDK cannot find the CLI it bundles, and the user's install
// is also the one their login belongs to.
export const ClaudeAdapterConfig = Context.Reference<{
	readonly executable: string;
}>("swarm/daemon/agents/claude/ClaudeAdapterConfig", {
	defaultValue: () => ({ executable: "claude" }),
});

const capabilities: AgentCapabilities = {
	resume: true,
	interrupt: true,
	fileChangeApprovals: true,
	mcpApprovals: true,
	// The SDK folds a message sent mid-turn into the running turn.
	steerWhileRunning: true,
};

// The SDK replaces the whole child environment when `env` is set, so API key mode passes
// these through explicitly. Subscription mode leaves `env` unset and inherits everything.
const inheritedVariables = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"];

const apiKeyEnvironment = Effect.fnUntraced(function* (apiKey: Redacted.Redacted<string>) {
	const env: Record<string, string> = {};
	for (const name of inheritedVariables) {
		const value = yield* Config.option(Config.String(name));
		if (Option.isSome(value)) env[name] = value.value;
	}
	env.ANTHROPIC_API_KEY = Redacted.value(apiKey);
	return env;
});

const fileTools = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

const toToolCall = (name: string, input: unknown): ToolCall => {
	if (name === "Bash") {
		const bash = Schema.decodeUnknownOption(BashInput)(input);
		if (Option.isSome(bash)) {
			return { kind: "command", command: bash.value.command, cwd: null };
		}
	}
	if (fileTools.has(name)) {
		const file = Schema.decodeUnknownOption(FileInput)(input);
		if (Option.isSome(file)) {
			const path = "file_path" in file.value ? file.value.file_path : file.value.notebook_path;
			// The SDK sends edit arguments, not a diff, so the diff stays empty.
			return {
				kind: "fileChange",
				changes: [{ path, kind: name === "Write" ? "add" : "update", diff: "" }],
			};
		}
	}
	// MCP tools are named mcp__<server>__<tool>.
	const [prefix, server, ...tool] = name.split("__");
	if (prefix === "mcp" && server !== undefined && tool.length > 0) {
		return { kind: "mcpCall", server, tool: tool.join("__") };
	}
	return { kind: "other", name };
};

// "Allow for session" may only add allow rules for this session. Suggestions that switch
// the permission mode, add directories, replace rules or write a settings file are dropped.
export const sessionAllowRules = (suggestions: ReadonlyArray<PermissionUpdate>): ReadonlyArray<PermissionUpdate> =>
	suggestions.flatMap((suggestion) =>
		suggestion.type === "addRules" && suggestion.behavior === "allow"
			? [{ ...suggestion, destination: "session" }]
			: [],
	);

const toPermissionResult = (
	outcome: ApprovalOutcome,
	input: Record<string, unknown>,
	suggestions: ReadonlyArray<PermissionUpdate>,
): PermissionResult => {
	switch (outcome) {
		case "allowOnce":
			return { behavior: "allow", updatedInput: input };
		case "allowForSession":
			return {
				behavior: "allow",
				updatedInput: input,
				updatedPermissions: [...suggestions],
			};
		case "deny":
			return { behavior: "deny", message: "The user denied this action." };
		case "cancelled":
			return {
				behavior: "deny",
				message: "The user stopped the turn.",
				interrupt: true,
			};
	}
};

const toolResultText = (
	content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }> | undefined,
) => {
	if (content === undefined) return null;
	if (typeof content === "string") return keepOutputTail(content);
	return keepOutputTail(content.map((part) => ("text" in part ? part.text : "")).join("\n"));
};

const makeMessageHandler = Effect.fnUntraced(function* (session: AgentSession) {
	// Stream deltas and finished blocks share an item id: the message id plus the block index.
	const streamingMessageId = yield* Ref.make("");
	const finishedBlocks = yield* Ref.make({ messageId: "", count: 0 });
	const tools = new Map<string, ToolCall>();
	const interrupting = yield* Ref.make(false);

	const handle = Effect.fnUntraced(function* (message: ClaudeMessage) {
		// Subagent frames belong to the Task tool call that started them.
		if ("parent_tool_use_id" in message && message.parent_tool_use_id !== null) return;
		switch (message.type) {
			case "system":
				if ("session_id" in message) {
					yield* session.setNativeSessionId(message.session_id);
				}
				return;
			case "stream_event": {
				if (!("event" in message)) return;
				const { event } = message;
				if (event.type === "message_start" && "message" in event) {
					return yield* Ref.set(streamingMessageId, event.message.id);
				}
				if ("delta" in event && "text" in event.delta) {
					const messageId = yield* Ref.get(streamingMessageId);
					return yield* session.emit({
						type: "message.delta",
						itemId: `${messageId}:${event.index}`,
						text: event.delta.text,
					});
				}
				return;
			}
			case "assistant": {
				if (!("message" in message) || !("id" in message.message)) return;
				const { id, content } = message.message;
				const previous = yield* Ref.get(finishedBlocks);
				let index = previous.messageId === id ? previous.count : 0;
				for (const block of content) {
					const itemId = `${id}:${index++}`;
					if ("text" in block) {
						yield* session.emit({
							type: "message.completed",
							itemId,
							text: block.text,
						});
					} else if ("name" in block) {
						const tool = toToolCall(block.name, block.input);
						tools.set(block.id, tool);
						yield* session.emit({
							type: "tool.started",
							itemId: block.id,
							tool,
						});
					}
				}
				return yield* Ref.set(finishedBlocks, { messageId: id, count: index });
			}
			case "user": {
				if (!("message" in message)) return;
				const { content } = message.message;
				if (typeof content === "string") return;
				for (const block of content) {
					if (!("tool_use_id" in block)) continue;
					const tool = tools.get(block.tool_use_id) ?? {
						kind: "other",
						name: "unknown",
					};
					tools.delete(block.tool_use_id);
					yield* session.emit({
						type: "tool.completed",
						itemId: block.tool_use_id,
						tool,
						status: block.is_error ? "failed" : "completed",
						output: toolResultText(block.content),
					});
				}
				return;
			}
			case "result": {
				if (!("uuid" in message)) return;
				const interrupted = yield* Ref.getAndSet(interrupting, false);
				return yield* session.emit({
					type: "turn.completed",
					turnId: message.uuid,
					result: interrupted
						? { status: "interrupted" }
						: message.subtype === "success"
							? { status: "completed" }
							: {
									status: "failed",
									message: message.errors?.join("; ") || message.subtype,
								},
				});
			}
			default:
				return yield* Effect.logDebug("Ignoring Claude message").pipe(Effect.annotateLogs({ type: message.type }));
		}
	});

	return { handle, interrupting };
});

export class ClaudeAdapter extends Context.Service<ClaudeAdapter, AgentAdapter>()(
	"swarm/daemon/agents/claude/ClaudeAdapter",
) {
	static readonly layer = Layer.effect(
		ClaudeAdapter,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const claudeQuery = yield* ClaudeQuery;
			const registry = yield* ProcessRegistry;

			const checkAuth = Effect.gen(function* () {
				const { executable } = yield* ClaudeAdapterConfig;
				const output = yield* spawner
					.string(ChildProcess.make(executable, ["auth", "status", "--json"]))
					.pipe(Effect.mapError(toAgentError(executable, "Could not run claude auth status.")));
				const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeAuthStatus))(output);
				if (Option.isNone(decoded)) {
					yield* Effect.logWarning("Could not read claude auth status output");
					return { status: "unknown" } satisfies AgentAuthStatus;
				}
				const { loggedIn, email, authMethod } = decoded.value;
				const status: AgentAuthStatus = loggedIn
					? { status: "loggedIn", account: email ?? authMethod ?? null }
					: { status: "loggedOut" };
				return status;
			}).pipe(Effect.withSpan("ClaudeAdapter.checkAuth"));

			const startSession = Effect.fn("ClaudeAdapter.startSession")(function* (input: StartSessionInput) {
				const { executable } = yield* ClaudeAdapterConfig;
				// The SDK wants a path, not a command name.
				const executablePath = Bun.which(executable);
				if (executablePath === null) {
					return yield* new AgentNotInstalledError({ executable });
				}
				const session = yield* makeAgentSession(capabilities);
				const prompts = yield* Queue.unbounded<SDKUserMessage>();
				const { handle, interrupting } = yield* makeMessageHandler(session);
				const context = yield* Effect.context();
				const runPromise = Effect.runPromiseWith(context);
				let claudePid: number | undefined;

				const canUseTool: CanUseTool = (toolName, toolInput, request) =>
					runPromise(
						Effect.gen(function* () {
							const suggestions = sessionAllowRules(request.suggestions ?? []);
							const choices: ReadonlyArray<ApprovalDecision> =
								suggestions.length > 0 && !request.suppressAlwaysAllowRule
									? ["allowOnce", "allowForSession", "deny"]
									: ["allowOnce", "deny"];
							const answered = yield* Deferred.make<ApprovalOutcome>();
							yield* session.requestApproval(
								{
									requestId: request.toolUseID,
									itemId: request.toolUseID,
									kind: toToolCall(toolName, toolInput).kind,
									summary: request.title ?? request.displayName ?? toolName,
									reason: request.decisionReason ?? null,
									choices,
								},
								(outcome) => Deferred.succeed(answered, outcome),
							);
							const outcome = yield* Deferred.await(answered);
							return toPermissionResult(outcome, toolInput, suggestions);
						}),
					);

				const options: Options = {
					cwd: input.cwd,
					model: input.model,
					includePartialMessages: true,
					canUseTool,
					// Never inherit a mode such as bypassPermissions from a settings file.
					permissionMode: "default",
					settingSources: input.trustProjectSettings ? ["user", "project", "local"] : ["user"],
					...(input.resumeId === undefined ? {} : { resume: input.resumeId }),
					pathToClaudeCodeExecutable: executablePath,
					spawnClaudeCodeProcess: (spawnOptions) => {
						const child = spawnInProcessGroup(spawnOptions);
						claudePid = child.pid;
						if (child.pid !== undefined) Effect.runForkWith(context)(registry.add(child.pid));
						return child;
					},
					...(input.auth.mode === "apiKey"
						? {
								// An optional plain string cannot fail to decode, so a ConfigError here is a defect.
								env: yield* Effect.orDie(apiKeyEnvironment(input.auth.apiKey)),
							}
						: {}),
				};

				const run = yield* Effect.acquireRelease(
					Effect.sync(() =>
						claudeQuery.start({
							prompt: Stream.toAsyncIterable(Stream.fromQueue(prompts)),
							options,
						}),
					),
					(run) =>
						Effect.gen(function* () {
							// Closing ends claude's stdin. Its process group then gets the usual stop signal and grace.
							run.close();
							if (claudePid === undefined) return;
							yield* stopProcessGroup(claudePid);
							yield* registry.remove(claudePid);
						}),
				);

				yield* Stream.fromAsyncIterable(
					run.messages,
					(cause) => new AgentProcessError({ message: "Claude Code stopped.", cause }),
				).pipe(
					Stream.mapEffect((message) =>
						Schema.decodeUnknownEffect(ClaudeMessage)(message).pipe(
							Effect.mapError(
								(cause) =>
									new AgentProtocolError({
										message: "Claude Code sent a message Swarm could not read.",
										cause,
									}),
							),
						),
					),
					Stream.runForEach(handle),
					Effect.andThen(session.end),
					Effect.catch(session.fail),
					Effect.forkScoped,
				);

				const sendText = (text: string) =>
					Effect.asVoid(
						Queue.offer(prompts, {
							type: "user",
							message: { role: "user", content: text },
							parent_tool_use_id: null,
						}),
					);

				return yield* session.start({
					startTurn: sendText,
					steerTurn: sendText,
					interruptTurn: Effect.gen(function* () {
						yield* Ref.set(interrupting, true);
						yield* Effect.tryPromise({
							try: () => run.interrupt(),
							catch: (cause) =>
								new AgentProcessError({
									message: "Could not interrupt Claude Code.",
									cause,
								}),
						});
					}),
				});
			});

			return ClaudeAdapter.of({
				kind: "claude",
				capabilities,
				checkAuth,
				startSession,
			});
		}),
	);
}
