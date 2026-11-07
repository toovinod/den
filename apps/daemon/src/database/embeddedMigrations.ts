import sessionEffort from "./migrations/20261107172147_sessionEffort/migration.sql" with { type: "text" };
import projectTrust from "./migrations/20261107165335_projectTrust/migration.sql" with { type: "text" };
import init from "./migrations/20261107072057_init/migration.sql" with { type: "text" };
import { formatToMillis } from "drizzle-orm/migrator.utils";
import type { MigrationMeta } from "drizzle-orm/migrator";

// A compiled daemon has no migrations folder on disk, so the SQL is imported into the bundle.
// Add one line here per folder drizzle-kit generates; embeddedMigrations.test.ts fails if one is missing.
const migrationFiles = [
	{ name: "20261107072057_init", sql: init },
	{ name: "20261107165335_projectTrust", sql: projectTrust },
	{ name: "20261107172147_sessionEffort", sql: sessionEffort },
] as const;

// Mirrors drizzle's readMigrationFiles so hashes match migrations applied from the folder.
const toMigrationMeta = (file: { readonly name: string; readonly sql: string }): MigrationMeta => ({
	sql: file.sql.split("--> statement-breakpoint"),
	bps: true,
	folderMillis: formatToMillis(file.name.slice(0, 14)),
	hash: new Bun.CryptoHasher("sha256").update(file.sql).digest("hex"),
	name: file.name,
});

export const embeddedMigrations = (): Array<MigrationMeta> => migrationFiles.map(toMigrationMeta);
