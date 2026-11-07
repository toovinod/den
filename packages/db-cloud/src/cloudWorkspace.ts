import { defineRelationsPart, sql } from "drizzle-orm";
import {
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, user } from "./authSchema.ts";

// What the user asked for. The worker drives observedState towards it.
export const requestedStates = ["running", "stopped", "archived"] as const;

// What the sandbox provider last reported. "unknown" means we lost track of the sandbox.
export const observedStates = [
	"provisioning",
	"running",
	"sleeping",
	"stopped",
	"failed",
	"unknown",
] as const;

export const sandboxProviders = ["vercel"] as const;

const timestampTz = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });

export const cloudWorkspace = pgTable(
	"cloud_workspace",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => Bun.randomUUIDv7()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdBy: text("created_by")
			.notNull()
			.references(() => user.id, { onDelete: "restrict" }),
		repositoryUrl: text("repository_url").notNull(),
		branch: text("branch").notNull(),
		baseBranch: text("base_branch").notNull(),
		requestedState: text("requested_state", { enum: requestedStates })
			.notNull()
			.default("running"),
		observedState: text("observed_state", { enum: observedStates })
			.notNull()
			.default("provisioning"),
		// The last provisioning step that completed, so a retry resumes after it.
		provisioningStep: text("provisioning_step"),
		sandboxProvider: text("sandbox_provider", {
			enum: sandboxProviders,
		}).notNull(),
		sandboxId: text("sandbox_id"),
		// The current sandbox instance. Relay connections from any other instance are stale.
		sandboxInstanceId: text("sandbox_instance_id"),
		attempts: integer("attempts").notNull().default(0),
		lastErrorCode: text("last_error_code"),
		lastErrorMessage: text("last_error_message"),
		lastSeenAt: timestampTz("last_seen_at"),
		observedStateChangedAt: timestampTz("observed_state_changed_at")
			.notNull()
			.defaultNow(),
		createdAt: timestampTz("created_at").notNull().defaultNow(),
		updatedAt: timestampTz("updated_at")
			.notNull()
			.defaultNow()
			.$onUpdate(() => sql`now()`),
	},
	(table) => [
		index("cloud_workspace_organization_id_idx").on(table.organizationId),
		uniqueIndex("cloud_workspace_sandbox_uidx").on(
			table.sandboxProvider,
			table.sandboxId,
		),
	],
);

export const cloudWorkspaceRelations = defineRelationsPart(
	{ cloudWorkspace, organization, user },
	(r) => ({
		cloudWorkspace: {
			organization: r.one.organization({
				from: r.cloudWorkspace.organizationId,
				to: r.organization.id,
			}),
			creator: r.one.user({
				from: r.cloudWorkspace.createdBy,
				to: r.user.id,
			}),
		},
	}),
);
