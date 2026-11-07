import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Schema, Stdio } from "effect";

// Tauri finds a sidecar by appending the Rust target triple to its `externalBin` name.
const rustTargets = {
	"bun-darwin-arm64": "aarch64-apple-darwin",
	"bun-darwin-x64": "x86_64-apple-darwin",
	"bun-linux-x64": "x86_64-unknown-linux-gnu",
	"bun-linux-arm64": "aarch64-unknown-linux-gnu",
} as const;

const BunTargets = Schema.Array(
	Schema.Literals(["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"]),
);

export class CompileError extends Schema.TaggedError<CompileError>()("CompileError", {
	target: Schema.String,
	exitCode: Schema.Int,
}) {
	override get message() {
		return `bun build --compile for ${this.target} exited with code ${this.exitCode}.`;
	}
}

const compile = Effect.fn("compile")(function* (target: keyof typeof rustTargets) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const exitCode = yield* spawner.exitCode(
		ChildProcess.make(
			"bun",
			[
				"build",
				"--compile",
				`--target=${target}`,
				// dend reads its settings only from the environment the app gives it, never from
				// a .env or bunfig.toml that happens to sit in its working directory.
				"--no-compile-autoload-dotenv",
				"--no-compile-autoload-bunfig",
				"src/main.ts",
				"--outfile",
				`dist/dend-${rustTargets[target]}`,
			],
			{ cwd: `${import.meta.dir}/..`, stdout: "inherit", stderr: "inherit" },
		),
	);
	if (exitCode !== 0) {
		return yield* new CompileError({ target, exitCode });
	}
});

// With no arguments this builds for the current machine, which is what `tauri build` bundles.
const main = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio;
	const args = yield* stdio.args;
	const targets = yield* Schema.decodeUnknownEffect(BunTargets)(
		args.length > 0 ? args : [`bun-${process.platform}-${process.arch}`],
	);
	yield* Effect.forEach(targets, compile, { discard: true });
});

BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
