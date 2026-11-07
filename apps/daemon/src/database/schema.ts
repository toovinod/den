import {
	AgentAuthMode,
	AgentKind,
	AgentSessionStatus,
} from "@repo/contracts/AgentSession";
import { JobStatus } from "@repo/contracts/JobStatus";
import { ScriptRunKind } from "@repo/contracts/ScriptRun";
import { WorkspaceKind, WorkspaceStatus } from "@repo/contracts/Workspace";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

// IDs are UUIDv7 text and times are ISO strings, written by the services.

export const project = sqliteTable(
	"project",
	{
		id: text().primaryKey(),
		name: text().notNull(),
		path: text().notNull(),
		defaultBranch: text().notNull(),
		setupScript: text(),
		runScript: text(),
		createdAt: text().notNull(),
	},
	(table) => [uniqueIndex("projectPathUnique").on(table.path)],
);

export const workspace = sqliteTable(
	"workspace",
	{
		id: text().primaryKey(),
		// Removing a project with active workspaces is refused in ProjectService.
		projectId: text()
			.notNull()
			.references(() => project.id, { onDelete: "cascade" }),
		name: text().notNull(),
		kind: text({ enum: WorkspaceKind.literals }).notNull(),
		path: text().notNull(),
		branch: text().notNull(),
		baseBranch: text().notNull(),
		status: text({ enum: WorkspaceStatus.literals }).notNull(),
		pullRequestUrl: text(),
		createdAt: text().notNull(),
		archivedAt: text(),
	},
	(table) => [
		index("workspaceProjectIdIndex").on(table.projectId),
		// Two active workspaces must never share a folder, including in-place ones.
		uniqueIndex("workspaceActivePathUnique")
			.on(table.path)
			.where(sql`${table.status} = 'active'`),
	],
);

export const agentSession = sqliteTable(
	"agentSession",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		agent: text({ enum: AgentKind.literals }).notNull(),
		model: text().notNull(),
		nativeSessionId: text(),
		authMode: text({ enum: AgentAuthMode.literals }).notNull(),
		status: text({ enum: AgentSessionStatus.literals }).notNull(),
		title: text(),
		createdAt: text().notNull(),
		updatedAt: text().notNull(),
	},
	(table) => [index("agentSessionWorkspaceIdIndex").on(table.workspaceId)],
);

export const sessionEvent = sqliteTable(
	"sessionEvent",
	{
		id: text().primaryKey(),
		sessionId: text()
			.notNull()
			.references(() => agentSession.id, { onDelete: "cascade" }),
		// Per session, monotonic and gapless for stored events.
		sequence: integer().notNull(),
		type: text().notNull(),
		// Trimmed JSON. Decode it with Schema when reading.
		payload: text({ mode: "json" }).notNull(),
		createdAt: text().notNull(),
	},
	// Also serves `WHERE sessionId = ? AND sequence > ? ORDER BY sequence LIMIT ?`.
	(table) => [
		uniqueIndex("sessionEventSessionSequenceUnique").on(
			table.sessionId,
			table.sequence,
		),
	],
);

export const scriptRun = sqliteTable(
	"scriptRun",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		kind: text({ enum: ScriptRunKind.literals }).notNull(),
		// Only transitionJob decides the next status, attempts and lastError.
		status: text({ enum: JobStatus.literals }).notNull(),
		attempts: integer().notNull().default(0),
		lastError: text(),
		exitCode: integer(),
		createdAt: text().notNull(),
		updatedAt: text().notNull(),
		startedAt: text(),
		finishedAt: text(),
	},
	(table) => [
		index("scriptRunWorkspaceIdIndex").on(table.workspaceId),
		index("scriptRunStatusIndex").on(table.status),
	],
);

export const setting = sqliteTable("setting", {
	key: text().primaryKey(),
	value: text({ mode: "json" }).notNull(),
});
