import { applyScriptRunEvent, executeScript } from "./runSetupScript.ts";
import { Effect } from "effect";

// A run script is usually a dev server the user starts and stops, so it has no timeout and no retries.
// Stopping it interrupts this effect; the caller records the cancellation.
export const runRunScript = Effect.fn("runRunScript")(
	function* (run: {
		readonly scriptRunId: string;
		readonly script: string;
		readonly cwd: string;
		readonly onLine: (line: string) => void;
	}) {
		yield* applyScriptRunEvent(run.scriptRunId, { _tag: "Started" });
		const result = yield* Effect.result(executeScript(run.script, run.cwd, run.onLine));
		if (result._tag === "Success") {
			yield* applyScriptRunEvent(run.scriptRunId, { _tag: "Succeeded" }, 0);
			return;
		}
		const error = result.failure;
		yield* Effect.logWarning("Run script failed", error);
		if (error._tag === "ScriptExitError") {
			yield* applyScriptRunEvent(
				run.scriptRunId,
				{ _tag: "FailedPermanently", error: `The run script exited with code ${error.exitCode}.` },
				error.exitCode,
			);
		} else {
			yield* applyScriptRunEvent(run.scriptRunId, {
				_tag: "FailedPermanently",
				error: "The run script could not be started.",
			});
		}
	},
	(effect, run) => effect.pipe(Effect.annotateLogs({ scriptRunId: run.scriptRunId })),
);
