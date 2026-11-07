import {
	AccountResponse,
	AgentMessageDelta,
	CommandApprovalParams,
	decodeCodex,
	ErrorNotification,
	FileChangeApprovalParams,
	ItemNotification,
	LoginResponse,
	ModelListResponse,
	type ThreadItem,
	ThreadResponse,
	TurnCompleted,
	TurnResponse,
} from "./codexProtocol.ts";
import {
	type AgentAdapter,
	type AgentAuthStatus,
	type AgentError,
	type AgentModels,
	AgentProtocolError,
	CodexVersionMismatchError,
	type SessionSettings,
	type StartSessionInput,
} from "../AgentAdapter.ts";
import { type CodexIncoming, type CodexRpcClient, METHOD_NOT_FOUND, makeCodexRpcClient } from "./codexRpcClient.ts";
import type { CommandExecutionApprovalDecision } from "./generated/v2/CommandExecutionApprovalDecision.ts";
import { Context, Effect, Exit, Layer, Option, Ref, Scope, Stream } from "effect";
import type { AgentCapabilities, AgentModel } from "@repo/contracts/AgentSession";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.ts";
import codexVersionFile from "./generated/CODEX_VERSION" with { type: "text" };
import type { LoginAccountParams } from "./generated/v2/LoginAccountParams.ts";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts";
import { type AgentSession, makeAgentSession } from "../makeAgentSession.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { ApprovalOutcome, ToolCall } from "@repo/contracts/AgentEvent";
import type { GetAccountParams } from "./generated/v2/GetAccountParams.ts";
import type { ModelListParams } from "./generated/v2/ModelListParams.ts";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts";
import type { InitializeParams } from "./generated/InitializeParams.ts";
import packageJson from "../../../package.json" with { type: "json" };
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { keepOutputTail } from "../keepOutputTail.ts";
import { toAgentError } from "../toAgentError.ts";

const CODEX_VERSION = codexVersionFile.trim();

// Releases bundle a pinned codex binary and point this at it.
export const CodexAdapterConfig = Context.Reference<{
	readonly executable: string;
}>("swarm/daemon/agents/codex/CodexAdapterConfig", {
	defaultValue: () => ({ executable: "codex" }),
});

const capabilities: AgentCapabilities = {
	resume: true,
	interrupt: true,
	fileChangeApprovals: true,
	// Codex asks MCP questions through elicitation requests, which Swarm declines for now.
	mcpApprovals: false,
	steerWhileRunning: true,
};

const approvalChoices = ["allowOnce", "allowForSession", "deny"] as const;

// Set on every thread so the user's own Codex config cannot turn Swarm's approvals off.
const threadPolicy = {
	approvalPolicy: "on-request",
	sandbox: "workspace-write",
} as const satisfies Pick<ThreadStartParams, "approvalPolicy" | "sandbox">;

const codexDecisions = {
	allowOnce: "accept",
	allowForSession: "acceptForSession",
	deny: "decline",
	cancelled: "cancel",
} as const satisfies Record<ApprovalOutcome, CommandExecutionApprovalDecision>;

const toToolCall = (item: ThreadItem): ToolCall | undefined => {
	switch (item.type) {
		case "commandExecution":
			return "command" in item ? { kind: "command", command: item.command, cwd: item.cwd } : undefined;
		case "fileChange":
			return "changes" in item
				? {
						kind: "fileChange",
						changes: item.changes.map((change) => ({
							path: change.path,
							kind: change.kind.type,
							diff: change.diff,
						})),
					}
				: undefined;
		case "mcpToolCall":
			return "server" in item ? { kind: "mcpCall", server: item.server, tool: item.tool } : undefined;
		default:
			return undefined;
	}
};

const toolStatus = (item: ThreadItem) =>
	"status" in item && (item.status === "failed" || item.status === "declined") ? item.status : "completed";

const toolOutput = (item: ThreadItem) => {
	if ("aggregatedOutput" in item && item.aggregatedOutput !== null) {
		return keepOutputTail(item.aggregatedOutput);
	}
	return "error" in item && item.error !== null ? item.error.message : null;
};

const checkVersion = Effect.fn("CodexAdapter.checkVersion")(function* (executable: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const output = yield* spawner
		.string(ChildProcess.make(executable, ["--version"]))
		.pipe(Effect.mapError(toAgentError(executable, "Could not run codex --version.")));
	// `codex --version` prints "codex-cli <version>".
	const actual = output.trim().split(" ").at(-1) ?? "";
	if (actual !== CODEX_VERSION) {
		return yield* new CodexVersionMismatchError({
			expected: CODEX_VERSION,
			actual,
		});
	}
});

const initialize = Effect.fn("CodexAdapter.initialize")(function* (client: CodexRpcClient) {
	yield* client.request("initialize", {
		clientInfo: { name: "swarm", title: "Swarm", version: packageJson.version },
		capabilities: { experimentalApi: false, requestAttestation: false },
	} satisfies InitializeParams);
	yield* client.notify("initialized");
});

const appServer = (executable: string, cwd?: string, env?: ChildProcess.CommandOptions["env"]) =>
	ChildProcess.make(executable, ["app-server"], {
		...(cwd === undefined ? {} : { cwd }),
		...(env === undefined ? {} : { env }),
		extendEnv: true,
	});

const handleNotification = Effect.fnUntraced(function* (
	session: AgentSession,
	currentTurn: Ref.Ref<Option.Option<string>>,
	method: string,
	params: unknown,
) {
	switch (method) {
		case "item/agentMessage/delta": {
			const { itemId, delta } = yield* decodeCodex(AgentMessageDelta)(params);
			return yield* session.emit({
				type: "message.delta",
				itemId,
				text: delta,
			});
		}
		case "item/started": {
			const { item } = yield* decodeCodex(ItemNotification)(params);
			const tool = toToolCall(item);
			if (tool === undefined) return;
			return yield* session.emit({
				type: "tool.started",
				itemId: item.id,
				tool,
			});
		}
		case "item/completed": {
			const { item } = yield* decodeCodex(ItemNotification)(params);
			if (item.type === "agentMessage" && "text" in item) {
				return yield* session.emit({
					type: "message.completed",
					itemId: item.id,
					text: item.text,
				});
			}
			const tool = toToolCall(item);
			if (tool === undefined) return;
			return yield* session.emit({
				type: "tool.completed",
				itemId: item.id,
				tool,
				status: toolStatus(item),
				output: toolOutput(item),
			});
		}
		case "turn/completed": {
			const { turn } = yield* decodeCodex(TurnCompleted)(params);
			yield* Ref.set(currentTurn, Option.none());
			return yield* session.emit({
				type: "turn.completed",
				turnId: turn.id,
				result:
					turn.status === "interrupted"
						? { status: "interrupted" }
						: turn.status === "failed"
							? {
									status: "failed",
									message: turn.error?.message ?? "The turn failed.",
								}
							: { status: "completed" },
			});
		}
		case "error": {
			const { error, willRetry } = yield* decodeCodex(ErrorNotification)(params);
			return yield* session.emit({
				type: "error",
				message: error.message,
				willRetry,
			});
		}
		default:
			return yield* Effect.logDebug("Ignoring Codex notification").pipe(Effect.annotateLogs({ method }));
	}
});

const handleServerRequest = Effect.fnUntraced(function* (
	session: AgentSession,
	client: CodexRpcClient,
	request: Extract<CodexIncoming, { _tag: "request" }>,
) {
	const respond = (outcome: ApprovalOutcome) => client.respond(request.id, { decision: codexDecisions[outcome] });
	const requestId = `${request.id}`;
	switch (request.method) {
		case "item/commandExecution/requestApproval": {
			const params = yield* decodeCodex(CommandApprovalParams)(request.params);
			return yield* session.requestApproval(
				{
					requestId,
					itemId: params.itemId,
					kind: "command",
					summary: params.command ?? "Run a command",
					reason: params.reason ?? null,
					choices: approvalChoices,
				},
				respond,
			);
		}
		case "item/fileChange/requestApproval": {
			const params = yield* decodeCodex(FileChangeApprovalParams)(request.params);
			return yield* session.requestApproval(
				{
					requestId,
					itemId: params.itemId,
					kind: "fileChange",
					summary: params.grantRoot ? `Allow writes under ${params.grantRoot}` : "Apply file changes",
					reason: params.reason ?? null,
					choices: approvalChoices,
				},
				respond,
			);
		}
		default:
			// Never leave Codex waiting on a request we cannot answer.
			yield* client.respondError(request.id, METHOD_NOT_FOUND, `Swarm does not support ${request.method}`);
			return yield* session.emit({
				type: "error",
				message: `Codex asked for ${request.method}, which Swarm does not support yet. It was declined.`,
				willRetry: false,
			});
	}
});

// Codex runs its own ChatGPT sign-in, which Claude has no equivalent for.
export interface CodexAgentAdapter extends AgentAdapter {
	// Returns the URL to open. Codex stores the tokens itself when the user finishes.
	readonly startLogin: Effect.Effect<string, AgentError>;
}

// Codex waits on its local callback server until the user finishes in the browser.
const LOGIN_TIMEOUT = "10 minutes";

export class CodexAdapter extends Context.Service<CodexAdapter, CodexAgentAdapter>()(
	"swarm/daemon/agents/codex/CodexAdapter",
) {
	static readonly layer = Layer.effect(
		CodexAdapter,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const provide = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner);
			const layerScope = yield* Effect.scope;

			// A short-lived app-server for questions outside a session. Closing the scope stops it.
			const connect = Effect.gen(function* () {
				const { executable } = yield* CodexAdapterConfig;
				yield* checkVersion(executable);
				const client = yield* makeCodexRpcClient(appServer(executable));
				yield* initialize(client);
				return client;
			});

			const checkAuth = Effect.gen(function* () {
				const client = yield* connect;
				const { account, requiresOpenaiAuth } = yield* client
					.request("account/read", {
						refreshToken: false,
					} satisfies GetAccountParams)
					.pipe(Effect.flatMap(decodeCodex(AccountResponse)));
				const status: AgentAuthStatus =
					account === null
						? requiresOpenaiAuth
							? { status: "loggedOut" }
							: { status: "unknown" }
						: {
								status: "loggedIn",
								account: "email" in account ? account.email : account.type,
							};
				return status;
			}).pipe(Effect.scoped, provide, Effect.withSpan("CodexAdapter.checkAuth"));

			// The installed Codex knows which models the account can use, so the list comes from it.
			const listModels = Effect.gen(function* () {
				const client = yield* connect;
				const models: Array<AgentModel> = [];
				let defaultModel = "";
				let cursor: string | null = null;
				do {
					const page: typeof ModelListResponse.Type = yield* client
						.request("model/list", { cursor } satisfies ModelListParams)
						.pipe(Effect.flatMap(decodeCodex(ModelListResponse)));
					for (const model of page.data) {
						// model/list has no context window. Codex reports it per thread in its token usage instead.
						models.push({
							id: model.id,
							label: model.displayName,
							description: model.description,
							efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
							defaultEffort: model.defaultReasoningEffort,
							contextWindow: null,
							supportsImages: model.inputModalities.includes("image"),
						});
						if (model.isDefault) defaultModel = model.id;
					}
					cursor = page.nextCursor;
				} while (cursor !== null);
				return { models, defaultModel: defaultModel || (models[0]?.id ?? "") } satisfies AgentModels;
			}).pipe(Effect.scoped, provide, Effect.withSpan("CodexAdapter.listModels"));

			const startLogin = Effect.gen(function* () {
				const scope = yield* Scope.make();
				const login = yield* Effect.gen(function* () {
					const client = yield* connect;
					const { authUrl } = yield* client
						.request("account/login/start", { type: "chatgpt" } satisfies LoginAccountParams)
						.pipe(Effect.flatMap(decodeCodex(LoginResponse)));
					return { client, authUrl };
				}).pipe(
					Scope.provide(scope),
					Effect.onError(() => Scope.close(scope, Exit.void)),
				);
				// The app-server must outlive this call, or the browser sign-in has nothing to return to.
				yield* login.client.incoming.pipe(
					Stream.takeUntil(
						(message) => message._tag === "notification" && message.method === "account/login/completed",
					),
					Stream.runDrain,
					Effect.timeoutOption(LOGIN_TIMEOUT),
					Effect.catch((error) => Effect.logWarning("Codex sign-in stopped", error)),
					Effect.ensuring(Scope.close(scope, Exit.void)),
					Effect.forkIn(layerScope),
				);
				return login.authUrl;
			}).pipe(provide, Effect.withSpan("CodexAdapter.startLogin"));

			const startSession = Effect.fn("CodexAdapter.startSession")(function* (input: StartSessionInput) {
				const { executable } = yield* CodexAdapterConfig;
				yield* checkVersion(executable);
				const session = yield* makeAgentSession(capabilities);
				const currentTurn = yield* Ref.make(Option.none<string>());
				// Sent with every turn, so a change applies from the next one.
				const settings = yield* Ref.make<SessionSettings>({ model: input.model, effort: input.effort });
				const client = yield* makeCodexRpcClient(
					appServer(
						executable,
						input.cwd,
						input.auth.mode === "apiKey" ? { OPENAI_API_KEY: input.auth.apiKey } : undefined,
					),
				);

				yield* client.incoming.pipe(
					Stream.runForEach((message) =>
						message._tag === "notification"
							? handleNotification(session, currentTurn, message.method, message.params)
							: handleServerRequest(session, client, message),
					),
					Effect.andThen(session.end),
					Effect.catch(session.fail),
					Effect.forkScoped,
				);

				yield* Effect.gen(function* () {
					yield* initialize(client);
					const response =
						input.resumeId === undefined
							? yield* client.request("thread/start", {
									model: input.model,
									cwd: input.cwd,
									...threadPolicy,
								} satisfies ThreadStartParams)
							: yield* client.request("thread/resume", {
									threadId: input.resumeId,
									model: input.model,
									cwd: input.cwd,
									...threadPolicy,
								} satisfies ThreadResumeParams);
					const { thread } = yield* decodeCodex(ThreadResponse)(response);
					yield* session.setNativeSessionId(thread.id);
				}).pipe(Effect.catch(session.fail), Effect.forkScoped);

				const textInput = (text: string) => [{ type: "text" as const, text, text_elements: [] }];

				return yield* session.start({
					startTurn: (text) =>
						Effect.gen(function* () {
							const threadId = yield* session.nativeSessionId;
							const { model, effort } = yield* Ref.get(settings);
							const { turn } = yield* client
								.request("turn/start", {
									threadId,
									model,
									effort,
									input: textInput(text),
								} satisfies TurnStartParams)
								.pipe(Effect.flatMap(decodeCodex(TurnResponse)));
							yield* Ref.set(currentTurn, Option.some(turn.id));
						}),
					steerTurn: (text) =>
						Effect.gen(function* () {
							const threadId = yield* session.nativeSessionId;
							const turnId = yield* Ref.get(currentTurn);
							if (Option.isNone(turnId)) {
								return yield* new AgentProtocolError({
									message: "Codex has not started the turn yet, so it cannot be steered.",
									cause: null,
								});
							}
							yield* client.request("turn/steer", {
								threadId,
								input: textInput(text),
								expectedTurnId: turnId.value,
							} satisfies TurnSteerParams);
						}),
					updateSettings: (next) => Ref.set(settings, next),
					interruptTurn: Effect.gen(function* () {
						const threadId = yield* session.nativeSessionId;
						const turnId = yield* Ref.get(currentTurn);
						if (Option.isNone(turnId)) return;
						yield* client.request("turn/interrupt", {
							threadId,
							turnId: turnId.value,
						} satisfies TurnInterruptParams);
					}),
				});
			}, provide);

			return CodexAdapter.of({
				kind: "codex",
				capabilities,
				authModes: ["apiKey", "subscription"],
				checkAuth,
				listModels,
				startLogin,
				startSession,
			});
		}),
	);
}
