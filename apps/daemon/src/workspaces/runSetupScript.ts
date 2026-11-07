import { and, eq } from "drizzle-orm";
import { Duration, Effect, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { LocalDatabase } from "../database/LocalDatabase.ts";
import { nowIso } from "../database/nowIso.ts";
import { scriptRun } from "../database/schema.ts";
import { IllegalJobTransitionError, type JobEvent, transitionJob } from "../jobs/transitionJob.ts";
import type { CappedOutput } from "./CappedOutput.ts";
import { SetupScriptSettings } from "./SetupScriptSettings.ts";

// Permanent: the script ran and failed. Retrying would only repeat it, so the user decides.
export class ScriptExitError extends Schema.TaggedError<ScriptExitError>()("ScriptExitError", {
	exitCode: Schema.Int,
}) {
	override get message() {
		return `The setup script exited with code ${this.exitCode}.`;
	}
}

// Retryable: a hung network install or a slow machine may pass next time.
export class ScriptTimeoutError extends Schema.TaggedError<ScriptTimeoutError>()("ScriptTimeoutError", {
	timeout: Schema.String,
}) {
	override get message() {
		return `The setup script did not finish within ${this.timeout}.`;
	}
}

// Retryable: the shell could not start, usually from a transient limit like too many open files.
export class ScriptSpawnError extends Schema.TaggedError<ScriptSpawnError>()("ScriptSpawnError", {
	cause: Schema.Defect(),
}) {
	override get message() {
		return "The setup script could not be started.";
	}
}

type ScriptError = ScriptExitError | ScriptTimeoutError | ScriptSpawnError;

const isRetryable = (error: ScriptError) => error._tag !== "ScriptExitError";

// Signals Effect.retry that the run went back to pending and should run again.
class ScriptRetryScheduled extends Schema.TaggedError<ScriptRetryScheduled>()("ScriptRetryScheduled", {}) {}

export const applyScriptRunEvent = Effect.fn("applyScriptRunEvent")(function* (
	scriptRunId: string,
	event: JobEvent,
	exitCode?: number,
) {
	const database = yield* LocalDatabase;
	const now = yield* nowIso;
	const outcome = yield* database.query((db) =>
		db.transaction((tx) =>
			Effect.gen(function* () {
				const [row] = yield* tx
					.select({ status: scriptRun.status, attempts: scriptRun.attempts })
					.from(scriptRun)
					.where(eq(scriptRun.id, scriptRunId));
				if (row === undefined) {
					return { _tag: "Missing" } as const;
				}
				const result = transitionJob(row, event, now);
				if (result._tag === "Failure") {
					return { _tag: "Illegal", error: result.failure } as const;
				}
				yield* tx
					.update(scriptRun)
					.set(exitCode === undefined ? result.success : { ...result.success, exitCode })
					.where(and(eq(scriptRun.id, scriptRunId), eq(scriptRun.status, row.status)));
				return { _tag: "Applied", update: result.success } as const;
			}),
		),
	);
	switch (outcome._tag) {
		case "Missing":
			// The workspace and its runs were deleted with their project.
			return yield* new IllegalJobTransitionError({
				from: "missing",
				event: event._tag,
			});
		case "Illegal":
			return yield* outcome.error;
		case "Applied":
			return outcome.update;
	}
});

const executeScript = Effect.fn("executeScript")(
	function* (script: string, cwd: string, output: CappedOutput) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(ChildProcess.make(script, { cwd, shell: true }));
		yield* handle.all.pipe(
			Stream.decodeText(),
			Stream.splitLines,
			Stream.runForEach((line) => Effect.sync(() => output.append(line))),
		);
		const exitCode = yield* handle.exitCode;
		if (exitCode !== 0) {
			return yield* new ScriptExitError({ exitCode });
		}
	},
	Effect.scoped,
	(effect) => effect.pipe(Effect.catchTag("PlatformError", (cause) => Effect.fail(new ScriptSpawnError({ cause })))),
);

// Every status change goes through applyScriptRunEvent, so a restart knows where it stopped.
export const runSetupScript = Effect.fn("runSetupScript")(
	function* (run: {
		readonly scriptRunId: string;
		readonly script: string;
		readonly cwd: string;
		readonly output: CappedOutput;
	}) {
		const settings = yield* SetupScriptSettings;

		const attempt = Effect.gen(function* () {
			yield* applyScriptRunEvent(run.scriptRunId, { _tag: "Started" });
			const result = yield* executeScript(run.script, run.cwd, run.output).pipe(
				Effect.timeoutOrElse({
					duration: settings.timeout,
					orElse: () =>
						Effect.fail(
							new ScriptTimeoutError({
								timeout: Duration.format(settings.timeout),
							}),
						),
				}),
				Effect.result,
			);
			if (result._tag === "Success") {
				yield* applyScriptRunEvent(run.scriptRunId, { _tag: "Succeeded" }, 0);
				return;
			}
			const error = result.failure;
			yield* Effect.logWarning("Setup script attempt failed", error);
			if (!isRetryable(error)) {
				yield* applyScriptRunEvent(
					run.scriptRunId,
					{ _tag: "FailedPermanently", error: error.message },
					error._tag === "ScriptExitError" ? error.exitCode : undefined,
				);
				return;
			}
			const update = yield* applyScriptRunEvent(run.scriptRunId, {
				_tag: "FailedRetryably",
				error: error.message,
				maxAttempts: settings.maxAttempts,
			});
			if (update.status === "pending") {
				return yield* new ScriptRetryScheduled();
			}
			yield* Effect.logError("Setup script moved to deadLetter");
		});

		yield* attempt.pipe(
			Effect.retry({
				schedule: Schedule.exponential(settings.retryBaseDelay).pipe(Schedule.jittered),
				while: (error) => error._tag === "ScriptRetryScheduled",
			}),
		);
	},
	(effect, run) => effect.pipe(Effect.annotateLogs({ scriptRunId: run.scriptRunId })),
);
