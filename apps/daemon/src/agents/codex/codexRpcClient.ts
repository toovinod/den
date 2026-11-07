import { type AgentError, AgentProcessError, AgentProtocolError } from "../AgentAdapter.ts";
import { type Cause, Deferred, Effect, Queue, Schema, Stream } from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import { toAgentError } from "../toAgentError.ts";

// Codex app-server speaks JSON-RPC 2.0 without the "jsonrpc" field, one message per line.

const RequestId = Schema.Union([Schema.String, Schema.Number]);
export type RequestId = typeof RequestId.Type;

const IncomingMessage = Schema.Union([
	Schema.Struct({
		id: RequestId,
		method: Schema.String,
		params: Schema.optionalKey(Schema.Unknown),
	}),
	Schema.Struct({
		method: Schema.String,
		params: Schema.optionalKey(Schema.Unknown),
	}),
	Schema.Struct({
		id: RequestId,
		error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
	}),
	Schema.Struct({ id: RequestId, result: Schema.Unknown }),
]);
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(IncomingMessage));

export type CodexIncoming =
	| {
			readonly _tag: "notification";
			readonly method: string;
			readonly params: unknown;
	  }
	| {
			readonly _tag: "request";
			readonly id: RequestId;
			readonly method: string;
			readonly params: unknown;
	  };

export interface CodexRpcClient {
	// Notifications and server requests, in order. Fails when the app-server exits.
	readonly incoming: Stream.Stream<CodexIncoming, AgentError>;
	request(method: string, params: unknown): Effect.Effect<unknown, AgentError>;
	notify(method: string): Effect.Effect<void>;
	respond(id: RequestId, result: unknown): Effect.Effect<void>;
	respondError(id: RequestId, code: number, message: string): Effect.Effect<void>;
}

export const METHOD_NOT_FOUND = -32601;
// Incoming messages wait here for the adapter. A full buffer pauses reading stdout.
const INCOMING_BUFFER = 256;

// Spawns `codex app-server` in the caller's scope. Closing the scope kills the process.
export const makeCodexRpcClient = Effect.fn("makeCodexRpcClient")(function* (command: ChildProcess.StandardCommand) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner
		.spawn(command)
		.pipe(Effect.mapError(toAgentError(command.command, "Could not start Codex app-server.")));

	const outgoing = yield* Queue.unbounded<string>();
	const incoming = yield* Queue.bounded<CodexIncoming, AgentError | Cause.Done>(INCOMING_BUFFER);
	const pending = new Map<RequestId, Deferred.Deferred<unknown, AgentError>>();
	let nextId = 0;

	const send = (message: object) => Effect.asVoid(Queue.offer(outgoing, `${JSON.stringify(message)}\n`));

	const exited = new AgentProcessError({
		message: "Codex app-server exited.",
		cause: null,
	});

	const handleLine = (line: string) =>
		Effect.gen(function* () {
			if (line.trim() === "") return;
			const message = yield* decodeLine(line).pipe(
				Effect.mapError(
					(cause) =>
						new AgentProtocolError({
							message: "Codex sent a line Swarm could not read.",
							cause,
						}),
				),
			);
			if ("method" in message) {
				yield* Queue.offer(
					incoming,
					"id" in message
						? {
								_tag: "request",
								id: message.id,
								method: message.method,
								params: message.params,
							}
						: {
								_tag: "notification",
								method: message.method,
								params: message.params,
							},
				);
				return;
			}
			const deferred = pending.get(message.id);
			if (deferred === undefined) {
				return yield* Effect.logWarning("Codex answered an unknown request").pipe(
					Effect.annotateLogs({ id: message.id }),
				);
			}
			pending.delete(message.id);
			if ("error" in message) {
				yield* Deferred.fail(
					deferred,
					new AgentProtocolError({
						message: `Codex rejected a request: ${message.error.message}`,
						cause: message.error,
					}),
				);
			} else {
				yield* Deferred.succeed(deferred, message.result);
			}
		});

	yield* Stream.fromQueue(outgoing).pipe(
		Stream.encodeText,
		Stream.run(handle.stdin),
		Effect.catch((cause) => Effect.logWarning("Writing to Codex failed", cause)),
		Effect.forkScoped,
	);

	yield* handle.stderr.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.runForEach((line) => Effect.logDebug("codex stderr", line)),
		Effect.ignore,
		Effect.forkScoped,
	);

	yield* handle.stdout.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.mapError((cause) => new AgentProcessError({ message: "Reading from Codex failed.", cause })),
		Stream.runForEach(handleLine),
		Effect.andThen(Effect.fail(exited)),
		Effect.catch((error: AgentError) =>
			Effect.gen(function* () {
				for (const deferred of pending.values()) {
					yield* Deferred.fail(deferred, error);
				}
				pending.clear();
				yield* Queue.fail(incoming, error);
			}),
		),
		Effect.forkScoped,
	);

	return {
		incoming: Stream.fromQueue(incoming),
		request: (method, params) =>
			Effect.gen(function* () {
				const id = nextId++;
				const deferred = yield* Deferred.make<unknown, AgentError>();
				pending.set(id, deferred);
				yield* send({ id, method, params });
				return yield* Deferred.await(deferred);
			}).pipe(Effect.withSpan("CodexRpcClient.request", { attributes: { method } })),
		notify: (method) => send({ method }),
		respond: (id, result) => send({ id, result }),
		respondError: (id, code, message) => send({ id, error: { code, message } }),
	} satisfies CodexRpcClient;
});
