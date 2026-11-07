import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Predicate, Schema, Stream } from "effect";
import { DaemonClient } from "@repo/contracts/DaemonClient";
import { invoke, isTauri } from "@tauri-apps/api/core";

const DaemonConnection = Schema.Struct({
	url: Schema.String,
	token: Schema.String,
});

class DaemonConnectionError extends Schema.TaggedError<DaemonConnectionError>()("DaemonConnectionError", {
	cause: Schema.Defect(),
}) {
	override get message() {
		return "Swarm could not reach its daemon. Restart the app.";
	}
}

// Outside the desktop shell (a browser during development) the daemon URL comes from the build environment,
// for example NEXT_PUBLIC_SWARM_DAEMON_URL=ws://127.0.0.1:4799/rpc?token=dev.
const devDaemonUrl = process.env.NEXT_PUBLIC_SWARM_DAEMON_URL;

const DaemonClientFromShell = Layer.unwrap(
	Effect.gen(function* () {
		if (!isTauri() && devDaemonUrl !== undefined) {
			return DaemonClient.layer(devDaemonUrl);
		}
		const raw = yield* Effect.tryPromise({
			try: () => invoke<unknown>("daemon_connection"),
			catch: (cause) => new DaemonConnectionError({ cause }),
		});
		const { url, token } = yield* Schema.decodeUnknownEffect(DaemonConnection)(raw);
		return DaemonClient.layer(`${url.replace(/^http/, "ws")}/rpc?token=${encodeURIComponent(token)}`);
	}),
);

const daemonRuntime = ManagedRuntime.make(DaemonClientFromShell);

export type Daemon = DaemonClient["Service"];

// The one door from React to the daemon: components pass a function of the client and get a promise.
export const callDaemon = <A, E>(call: (daemon: Daemon) => Effect.Effect<A, E>): Promise<A> =>
	daemonRuntime.runPromise(Effect.flatMap(DaemonClient, call));

export interface Follow<A> {
	readonly onItem: (item: A) => void;
	// Called once when the stream ends: with null when it finished, or with the failure.
	readonly onEnd?: (error: unknown) => void;
}

// Runs a daemon stream until the returned function is called.
export const followDaemon = <A, E>(open: (daemon: Daemon) => Stream.Stream<A, E>, follow: Follow<A>) => {
	const fiber = daemonRuntime.runFork(
		Effect.flatMap(DaemonClient, (daemon) =>
			Stream.runForEach(open(daemon), (item) => Effect.sync(() => follow.onItem(item))),
		),
	);
	fiber.addObserver((exit) => {
		if (Exit.isSuccess(exit)) {
			follow.onEnd?.(null);
		} else if (!Cause.hasInterruptsOnly(exit.cause)) {
			follow.onEnd?.(Cause.squash(exit.cause));
		}
	});
	return () => {
		daemonRuntime.runFork(Fiber.interrupt(fiber));
	};
};

// Daemon errors carry a message written for the user. Anything else gets a generic one.
export const errorMessage = (error: unknown): string =>
	Predicate.hasProperty(error, "message") && Predicate.isString(error.message) && error.message !== ""
		? error.message
		: "Something went wrong. Try again.";

export const errorTag = (error: unknown): string | null =>
	Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : null;
