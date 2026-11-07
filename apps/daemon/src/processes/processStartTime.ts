import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { DateTime, Duration, Effect, Option } from "effect";

// `ps` reports start times to the second, and a recorded time can be taken just after the start.
const SAME_PROCESS_TOLERANCE = Duration.seconds(2);

// When a process started, from `ps`, to tell our own child from an unrelated process that
// reused its pid. None when `ps` cannot say. `lstart` has a resolution of one second and no
// zone, so ps prints it in UTC, which is how DateTime reads a time without a zone.
export const processStartTime = Effect.fn("processStartTime")(function* (pid: number) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const output = yield* spawner
		.string(
			ChildProcess.make("ps", ["-o", "lstart=", "-p", `${pid}`], { env: { LC_ALL: "C", TZ: "UTC" }, extendEnv: true }),
		)
		.pipe(Effect.option);
	return Option.flatMap(output, (text) => DateTime.make(text.trim()));
});

// Whether `pid` is still the process that was recorded as starting at `startedAt` (epoch millis).
// False when `ps` cannot say, so callers never act on an unrelated process.
export const wasStartedAt = Effect.fn("wasStartedAt")(function* (pid: number, recordedAt: number) {
	const started = yield* processStartTime(pid);
	return Option.match(started, {
		onNone: () => false,
		onSome: (time) =>
			Duration.isLessThanOrEqualTo(
				Duration.abs(DateTime.distance(time, DateTime.makeUnsafe(recordedAt))),
				SAME_PROCESS_TOLERANCE,
			),
	});
});
