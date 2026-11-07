import { DaemonInternalError } from "@repo/contracts/DaemonInternalError";
import { Effect, Predicate } from "effect";
import type { LocalDatabaseError } from "../database/LocalDatabase.ts";
import type { GitCommandError, GitSpawnError } from "../git/runGit.ts";
import type { IllegalJobTransitionError } from "../jobs/transitionJob.ts";

type InternalFailure = LocalDatabaseError | GitSpawnError | GitCommandError | IllegalJobTransitionError;

const isInternalFailure = (error: unknown): error is InternalFailure =>
	Predicate.isTagged(error, "LocalDatabaseError") ||
	Predicate.isTagged(error, "GitSpawnError") ||
	Predicate.isTagged(error, "GitCommandError") ||
	Predicate.isTagged(error, "IllegalJobTransitionError");

export const orInternalError =
	(operation: string) =>
	<A, E, R>(
		self: Effect.Effect<A, E | InternalFailure, R>,
	): Effect.Effect<A, Exclude<E, InternalFailure> | DaemonInternalError, R> =>
		self.pipe(
			Effect.catchIf(
				isInternalFailure,
				(cause) =>
					Effect.logError(`Could not ${operation}`, cause).pipe(
						Effect.andThen(Effect.fail(new DaemonInternalError({ operation }))),
					),
				// Passing the other errors on explicitly keeps their types precise.
				Effect.fail,
			),
		);
