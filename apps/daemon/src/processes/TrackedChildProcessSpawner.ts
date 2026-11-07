import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ProcessRegistry } from "./ProcessRegistry.ts";
import { STOP_GRACE } from "./stopProcessGroup.ts";
import { Effect, Layer } from "effect";

// Effect already spawns each command in its own process group and SIGTERMs the group when the
// scope closes. Without forceKillAfter it would wait forever for a child that ignores SIGTERM.
const withStopGrace = (command: ChildProcess.Command): ChildProcess.Command =>
	ChildProcess.isStandardCommand(command) && command.options.forceKillAfter === undefined
		? ChildProcess.make(command.command, command.args, { ...command.options, forceKillAfter: STOP_GRACE })
		: command;

// Replaces the platform spawner for everything the daemon starts: every child gets the stop
// grace and is recorded in the ProcessRegistry until it exits.
export const TrackedChildProcessSpawner = Layer.effect(
	ChildProcessSpawner.ChildProcessSpawner,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const registry = yield* ProcessRegistry;
		return ChildProcessSpawner.make((command) =>
			Effect.gen(function* () {
				const handle = yield* spawner.spawn(withStopGrace(command));
				yield* registry.add(handle.pid);
				// Removed only once the process has exited, not when its scope starts closing, so a
				// crash during the stop grace still leaves it in the registry.
				yield* handle.exitCode.pipe(Effect.ignore, Effect.andThen(registry.remove(handle.pid)), Effect.forkDetach);
				return handle;
			}),
		);
	}),
);
