import { Schema } from "effect";

// Every job (setup and run scripts, clones, pushes) shares this status union.
export const JobStatus = Schema.Literals([
	"pending",
	"processing",
	"completed",
	"failed",
	"deadLetter",
]);
export type JobStatus = typeof JobStatus.Type;
