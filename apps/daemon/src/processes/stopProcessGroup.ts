import { Duration, Effect, Option, Predicate, Schedule } from "effect";

// How long a child gets between the polite signal and SIGKILL (architecture section 3.3).
export const STOP_GRACE = Duration.seconds(5);

// Every child runs in its own process group, so one signal to -pgid reaches it and every
// descendant that stayed in the group. False means no member could be signalled.
export const signalProcessGroup = (pgid: number, signal: NodeJS.Signals | 0) =>
	Effect.try(() => process.kill(-pgid, signal)).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);

// True when the process exists, including one owned by another user (EPERM).
export const processExists = (pid: number) =>
	Effect.try({
		try: () => process.kill(pid, 0),
		catch: (error) => error,
	}).pipe(
		Effect.as(true),
		Effect.catch((error) => Effect.succeed(!(Predicate.hasProperty(error, "code") && error.code === "ESRCH"))),
	);

// Sends `signal` to the group, waits up to `grace` for every member to exit, then SIGKILLs it.
export const stopProcessGroup = Effect.fn("stopProcessGroup")(function* (
	pgid: number,
	options: { readonly signal?: NodeJS.Signals; readonly grace?: Duration.Input } = {},
) {
	if (!(yield* signalProcessGroup(pgid, options.signal ?? "SIGTERM"))) return;
	const exited = yield* signalProcessGroup(pgid, 0).pipe(
		Effect.repeat({ schedule: Schedule.spaced(Duration.millis(50)), while: (alive) => alive }),
		Effect.timeoutOption(options.grace ?? STOP_GRACE),
	);
	if (Option.isNone(exited)) {
		yield* Effect.logWarning("Process group ignored its stop signal, sending SIGKILL").pipe(
			Effect.annotateLogs({ pgid }),
		);
		yield* signalProcessGroup(pgid, "SIGKILL");
	}
});
