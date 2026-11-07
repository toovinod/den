import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class GitSpawnError extends Schema.TaggedError<GitSpawnError>()(
	"GitSpawnError",
	{ args: Schema.Array(Schema.String), cause: Schema.Defect() },
) {}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()(
	"GitCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Int,
		stderr: Schema.String,
	},
) {}

// Runs `git <args>` in `cwd` and returns stdout without trailing whitespace.
// Leading whitespace is kept because `git status --porcelain` lines start with a space.
export const runGit = Effect.fn("runGit")(
	function* (cwd: string, args: ReadonlyArray<string>) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			ChildProcess.make("git", args, { cwd }),
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
			Effect.catchTag("PlatformError", (cause) =>
				Effect.fail(new GitSpawnError({ args: [...args], cause })),
			),
		),
);
