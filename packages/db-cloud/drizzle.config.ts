import { defineConfig } from "drizzle-kit";

// Only `drizzle-kit generate` runs from here, which needs no database connection.
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema.ts",
	out: "./drizzle",
});
