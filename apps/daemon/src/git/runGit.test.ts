import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { GitTimeoutSettings } from "./GitTimeoutSettings.ts";
import { runInTempDir } from "../testing/runServiceTest.ts";
import { Duration, Effect, FileSystem } from "effect";
import { describe, expect, test } from "bun:test";
import { GhSettings, runGh } from "./runGh.ts";
import { runGit } from "./runGit.ts";
import { join } from "node:path";

const deadlines = (local: number, network: number) => ({
	local: Duration.millis(local),
	network: Duration.millis(network),
});

describe("git and gh deadlines", () => {
	test("stops a local git command that runs past its deadline", async () => {
		const result = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const repo = yield* makeTestRepository(join(tempDir, "repo"));
				const marker = join(tempDir, "finished");
				yield* runGit(repo, ["config", "alias.slow", `!sleep 1; touch "${marker}"`]);
				const error = yield* Effect.flip(
					runGit(repo, ["slow"]).pipe(Effect.provideService(GitTimeoutSettings, deadlines(100, 30_000))),
				);
				// Long enough for the alias to finish, had it not been killed.
				yield* Effect.sleep("1500 millis");
				return { error, finished: yield* fs.exists(marker) };
			}),
		);
		expect(result.error).toMatchObject({ _tag: "GitTimeoutError", command: "git slow", kind: "local" });
		expect(result.error.message).toBe(
			"`git slow` did not finish within 100ms, so Den stopped it. Check that no other git process is holding the repository, then try again.",
		);
		expect(result.finished).toBe(false);
	});

	test("gives push the longer network deadline", async () => {
		const result = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const repo = yield* makeTestRepository(join(tempDir, "repo"));
				// A remote that answers slowly and then hangs up, without touching the network.
				yield* runGit(repo, ["config", "core.sshCommand", "sh -c 'sleep 0.5' --"]);
				const push = runGit(repo, ["push", "ssh://den.invalid/repo.git", "main"]);
				return {
					withinNetwork: yield* Effect.flip(
						push.pipe(Effect.provideService(GitTimeoutSettings, deadlines(100, 30_000))),
					),
					pastNetwork: yield* Effect.flip(push.pipe(Effect.provideService(GitTimeoutSettings, deadlines(30_000, 100)))),
				};
			}),
		);
		expect(result.withinNetwork._tag).toBe("GitCommandError");
		expect(result.pastNetwork).toMatchObject({ _tag: "GitTimeoutError", command: "git push", kind: "network" });
	});

	test("stops a gh command that runs past the network deadline", async () => {
		const error = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const executable = join(tempDir, "gh");
				yield* fs.writeFileString(executable, "#!/bin/sh\nsleep 5\n");
				yield* fs.chmod(executable, 0o755);
				return yield* Effect.flip(
					runGh(tempDir, ["pr", "view"]).pipe(
						Effect.provideService(GhSettings, { executable }),
						Effect.provideService(GitTimeoutSettings, deadlines(30_000, 100)),
					),
				);
			}),
		);
		expect(error).toMatchObject({ _tag: "GitTimeoutError", command: "gh pr", kind: "network" });
	});
});
