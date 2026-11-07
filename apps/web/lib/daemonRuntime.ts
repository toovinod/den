import { DaemonClient } from "@repo/contracts/DaemonClient";
import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

const DaemonConnection = Schema.Struct({
	url: Schema.String,
	token: Schema.String,
});

class DaemonConnectionError extends Schema.TaggedError<DaemonConnectionError>()("DaemonConnectionError", {
	cause: Schema.Defect(),
}) {}

const DaemonClientFromShell = Layer.unwrap(
	Effect.gen(function* () {
		const raw = yield* Effect.tryPromise({
			try: () => invoke<unknown>("daemon_connection"),
			catch: (cause) => new DaemonConnectionError({ cause }),
		});
		const { url, token } = yield* Schema.decodeUnknownEffect(DaemonConnection)(raw);
		return DaemonClient.layer(`${url.replace(/^http/, "ws")}/rpc?token=${encodeURIComponent(token)}`);
	}),
);

export const daemonRuntime = ManagedRuntime.make(DaemonClientFromShell);

export const fetchDaemonVersion = () =>
	daemonRuntime.runPromise(
		Effect.gen(function* () {
			const client = yield* DaemonClient;
			const health = yield* client.health();
			return health.version;
		}),
	);
