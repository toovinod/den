import { Schema } from "effect";
import { JobStatus } from "./JobStatus.ts";

export const ScriptRunKind = Schema.Literals(["setup", "run"]);
export type ScriptRunKind = typeof ScriptRunKind.Type;

export class ScriptRun extends Schema.Class<ScriptRun>("ScriptRun")({
	id: Schema.String,
	workspaceId: Schema.String,
	kind: ScriptRunKind,
	status: JobStatus,
	attempts: Schema.Int,
	lastError: Schema.NullOr(Schema.String),
	exitCode: Schema.NullOr(Schema.Int),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	startedAt: Schema.NullOr(Schema.String),
	finishedAt: Schema.NullOr(Schema.String),
}) {}

export class ScriptRunOutput extends Schema.Class<ScriptRunOutput>("ScriptRunOutput")({
	scriptRunId: Schema.String,
	// The capped tail captured while this daemon was running. Empty after a restart.
	output: Schema.String,
}) {}
