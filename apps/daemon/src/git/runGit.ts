import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { withGitDeadline } from "./GitTimeoutSettings.ts";
import { Effect, Schema, Stream } from "effect";

export class GitSpawnError extends Schema.TaggedError<GitSpawnError>()("GitSpawnError", {
	args: Schema.Array(Schema.String),
	cause: Schema.Defect(),
}) {}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
	args: Schema.Array(Schema.String),
	exitCode: Schema.Int,
	stderr: Schema.String,
}) {}

// These reach a remote, so they get the longer deadline.
const NETWORK_COMMANDS = new Set(["push", "fetch", "pull", "clone", "ls-remote"]);

// Leading whitespace is kept because `git status --porcelain` lines start with a space.
export const runGit = Effect.fn("runGit")(
	function* (cwd: string, args: ReadonlyArray<string>) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		// Git must never wait for a password on a terminal nobody sees.
		const handle = yield* spawner.spawn(
			ChildProcess.make("git", args, {
				cwd,
				env: { GIT_TERMINAL_PROMPT: "0" },
				extendEnv: true,
				// After a timeout, a process that ignores SIGTERM must not hold the request either.
				forceKillAfter: "2 seconds",
			}),
		);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[
				Stream.mkString(Stream.decodeText(handle.stdout)),
				Stream.mkString(Stream.decodeText(handle.stderr)),
				handle.exitCode,
			],
			{ concurrency: "unbounded" },
		);
		if (exitCode !== 0) {
			return yield* new GitCommandError({
				args: [...args],
				exitCode,
				stderr: stderr.trim(),
			});
		}
		return stdout.trimEnd();
	},
	Effect.scoped,
	(effect, _cwd, args) =>
		effect.pipe(
			withGitDeadline(`git ${args[0] ?? ""}`, NETWORK_COMMANDS.has(args[0] ?? "") ? "network" : "local"),
			Effect.catchTag("PlatformError", (cause) => Effect.fail(new GitSpawnError({ args: [...args], cause }))),
		),
);
