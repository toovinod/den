import { describe, expect, test } from "bun:test";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { ConnectionError, SqlError, UniqueViolation } from "effect/sql/SqlError";
import { toCloudDatabaseError } from "./CloudDatabase.ts";

const connectionLost = new SqlError({
	reason: new ConnectionError({ cause: "socket closed" }),
});
const duplicate = new SqlError({
	reason: new UniqueViolation({ cause: "dup", constraint: "user_email_key" }),
});

describe("toCloudDatabaseError", () => {
	test("marks a lost connection as retryable", () => {
		expect(toCloudDatabaseError(connectionLost).retryable).toBe(true);
	});

	test("marks a unique violation as permanent", () => {
		expect(toCloudDatabaseError(duplicate).retryable).toBe(false);
	});

	test("looks through Drizzle's query error to the SQL error", () => {
		const wrapped = new EffectDrizzleQueryError({
			query: "select 1",
			params: [],
			cause: connectionLost,
		});
		expect(toCloudDatabaseError(wrapped).retryable).toBe(true);
	});

	test("treats a Drizzle error without a SQL cause as permanent", () => {
		const wrapped = new EffectDrizzleQueryError({
			query: "select 1",
			params: [],
			cause: "mapping failed",
		});
		expect(toCloudDatabaseError(wrapped).retryable).toBe(false);
	});
});
