import { embeddedMigrations } from "./embeddedMigrations.ts";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("embeddedMigrations", () => {
	test("embeds every migration drizzle-kit generated, with the same hashes", () => {
		const fromFolder = readMigrationFiles({
			migrationsFolder: join(import.meta.dir, "migrations"),
		});
		expect(embeddedMigrations()).toEqual(fromFolder);
	});
});
