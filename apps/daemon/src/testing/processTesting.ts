import { processExists, signalProcessGroup } from "../processes/stopProcessGroup.ts";
import { Duration, Effect, FileSystem, Option, Schedule } from "effect";

// Prints the pid of a grandchild, then waits for it, so a test can check the grandchild dies.
export const WITH_GRANDCHILD = "sleep 30 & echo $!; wait";

// Polls until the process is gone. Reparented orphans are reaped by init a moment after they die.
export const isGoneWithin = (pid: number, timeout: Duration.Input = Duration.seconds(3)) =>
	processExists(pid).pipe(
		Effect.repeat({ schedule: Schedule.spaced(Duration.millis(25)), while: (alive) => alive }),
		Effect.timeoutOption(timeout),
		Effect.map(Option.isSome),
	);

// A shell in its own process group, started outside Effect like a child a crashed daemon left.
// Returns once the shell has printed the pid of its grandchild.
export const spawnDetachedShell = (script: string) =>
	Effect.gen(function* () {
		const shell = Bun.spawn(["/bin/sh", "-c", script], { detached: true, stdout: "pipe" });
		const reader = shell.stdout.getReader();
		const { value } = yield* Effect.promise(() => reader.read());
		reader.releaseLock();
		const grandchild = Number(new TextDecoder().decode(value).trim().split("\n")[0]);
		return { shell, grandchild };
	});

// Makes sure a failed test does not leave its processes running.
export const killGroupOnExit = (pgid: number) => Effect.addFinalizer(() => signalProcessGroup(pgid, "SIGKILL"));

// A run script that, once asked to stop, holds the archive up until the test creates `release`.
// It leaves `stopping` behind, so the test knows the archive is under way.
export const SLOW_TO_STOP =
	"trap 'touch stopping; while [ ! -f release ]; do sleep 0.05; done; exit 0' TERM; echo ready; while true; do sleep 0.1; done";

export const waitForFile = (path: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)).pipe(
		Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (exists) => exists }),
		Effect.timeout("4 seconds"),
	);
