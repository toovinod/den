import type { JobStatus } from "@repo/contracts/JobStatus";
import { Result, Schema } from "effect";

export interface JobState {
	readonly status: JobStatus;
	readonly attempts: number;
}

export type JobEvent =
	| { readonly _tag: "Started" }
	| { readonly _tag: "Succeeded" }
	| { readonly _tag: "FailedPermanently"; readonly error: string }
	| {
			readonly _tag: "FailedRetryably";
			readonly error: string;
			readonly maxAttempts: number;
	  }
	| { readonly _tag: "Cancelled"; readonly reason: string };

export interface JobUpdate {
	readonly status: JobStatus;
	readonly attempts: number;
	readonly lastError: string | null;
	readonly updatedAt: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
}

export class IllegalJobTransitionError extends Schema.TaggedError<IllegalJobTransitionError>()(
	"IllegalJobTransitionError",
	{ from: Schema.String, event: Schema.String },
) {}

// The only place a job's status changes. Every legal move is listed; anything else is refused.
export const transitionJob = (
	job: JobState,
	event: JobEvent,
	now: string,
): Result.Result<JobUpdate, IllegalJobTransitionError> => {
	const illegal = Result.fail(new IllegalJobTransitionError({ from: job.status, event: event._tag }));
	switch (event._tag) {
		case "Started":
			return job.status === "pending"
				? Result.succeed({
						status: "processing",
						attempts: job.attempts,
						lastError: null,
						updatedAt: now,
						startedAt: now,
					})
				: illegal;
		case "Succeeded":
			return job.status === "processing"
				? Result.succeed({
						status: "completed",
						attempts: job.attempts,
						lastError: null,
						updatedAt: now,
						finishedAt: now,
					})
				: illegal;
		case "FailedPermanently":
			return job.status === "processing"
				? Result.succeed({
						status: "failed",
						attempts: job.attempts,
						lastError: event.error,
						updatedAt: now,
						finishedAt: now,
					})
				: illegal;
		case "FailedRetryably": {
			if (job.status !== "processing") {
				return illegal;
			}
			const attempts = job.attempts + 1;
			return Result.succeed(
				attempts < event.maxAttempts
					? {
							status: "pending",
							attempts,
							lastError: event.error,
							updatedAt: now,
						}
					: {
							status: "deadLetter",
							attempts,
							lastError: event.error,
							updatedAt: now,
							finishedAt: now,
						},
			);
		}
		case "Cancelled":
			return job.status === "pending" || job.status === "processing"
				? Result.succeed({
						status: "failed",
						attempts: job.attempts,
						lastError: event.reason,
						updatedAt: now,
						finishedAt: now,
					})
				: illegal;
	}
};
