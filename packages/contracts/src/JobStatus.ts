import { Schema } from "effect";

export const JobStatus = Schema.Literals([
	"pending",
	"processing",
	"completed",
	"failed",
	"deadLetter",
]);
export type JobStatus = typeof JobStatus.Type;
