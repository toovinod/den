import type { AgentError, ApprovalChoiceError } from "../agents/AgentAdapter.ts";
import { DaemonInternalError } from "@repo/contracts/DaemonInternalError";
import type { IllegalJobTransitionError } from "../jobs/transitionJob.ts";
import type { CredentialStoreError } from "../agents/CredentialStore.ts";
import type { GitCommandError, GitSpawnError } from "../git/runGit.ts";
import type { LocalDatabaseError } from "../database/LocalDatabase.ts";
import { Effect, Predicate } from "effect";

type InternalFailure =
	| LocalDatabaseError
	| GitSpawnError
	| GitCommandError
	| IllegalJobTransitionError
	| CredentialStoreError
	| AgentError
	| ApprovalChoiceError;

const internalTags: ReadonlyArray<InternalFailure["_tag"]> = [
	"LocalDatabaseError",
	"GitSpawnError",
	"GitCommandError",
	"IllegalJobTransitionError",
	"CredentialStoreError",
	"AgentProcessError",
	"AgentNotInstalledError",
	"AgentProtocolError",
	"CodexVersionMismatchError",
	"ApprovalChoiceError",
];

const isInternalFailure = (error: unknown): error is InternalFailure =>
	internalTags.some((tag) => Predicate.isTagged(error, tag));

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
