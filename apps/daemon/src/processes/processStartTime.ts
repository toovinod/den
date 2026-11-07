import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { DateTime, Effect, Option } from "effect";

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
