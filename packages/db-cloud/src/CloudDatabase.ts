import { PgClient } from "@effect/sql-pg";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { isSqlError, type SqlError } from "effect/sql/SqlError";
import { relations } from "./schema.ts";

export class CloudDatabaseError extends Schema.TaggedError<CloudDatabaseError>()(
	"CloudDatabaseError",
	{
		// True for connection loss, deadlocks, serialization failures and timeouts.
		retryable: Schema.Boolean,
		cause: Schema.Defect(),
	},
) {}

export const toCloudDatabaseError = (
	error: EffectDrizzleQueryError | SqlError,
): CloudDatabaseError => {
	const sqlError = isSqlError(error) ? error : error.cause;
	return new CloudDatabaseError({
		retryable: isSqlError(sqlError) && sqlError.isRetryable,
		cause: error,
	});
};

const makeDatabase = PgDrizzle.makeWithDefaults({ relations });
export type CloudDrizzle = Effect.Success<typeof makeDatabase>;

export class CloudDatabase extends Context.Service<
	CloudDatabase,
	{
		query<A>(
			run: (
				db: CloudDrizzle,
			) => Effect.Effect<A, EffectDrizzleQueryError | SqlError>,
		): Effect.Effect<A, CloudDatabaseError>;
	}
>()("swarm/db-cloud/CloudDatabase") {
	static readonly layer = Layer.effect(
		CloudDatabase,
		Effect.gen(function* () {
			const db = yield* makeDatabase;
			return CloudDatabase.of({
				query: (run) =>
					run(db).pipe(
						Effect.mapError(toCloudDatabaseError),
						Effect.withSpan("CloudDatabase.query"),
					),
			});
		}),
	).pipe(
		Layer.provide(
			PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }),
		),
	);
}
