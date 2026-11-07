CREATE TABLE `agentSession` (
	`id` text PRIMARY KEY,
	`workspaceId` text NOT NULL,
	`agent` text NOT NULL,
	`model` text NOT NULL,
	`nativeSessionId` text,
	`authMode` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	CONSTRAINT `fk_agentSession_workspaceId_workspace_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspace`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`defaultBranch` text NOT NULL,
	`setupScript` text,
	`runScript` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scriptRun` (
	`id` text PRIMARY KEY,
	`workspaceId` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`exitCode` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`startedAt` text,
	`finishedAt` text,
	CONSTRAINT `fk_scriptRun_workspaceId_workspace_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspace`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sessionEvent` (
	`id` text PRIMARY KEY,
	`sessionId` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` text NOT NULL,
	CONSTRAINT `fk_sessionEvent_sessionId_agentSession_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `agentSession`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY,
	`projectId` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`baseBranch` text NOT NULL,
	`status` text NOT NULL,
	`pullRequestUrl` text,
	`createdAt` text NOT NULL,
	`archivedAt` text,
	CONSTRAINT `fk_workspace_projectId_project_id_fk` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `agentSessionWorkspaceIdIndex` ON `agentSession` (`workspaceId`);--> statement-breakpoint
CREATE UNIQUE INDEX `projectPathUnique` ON `project` (`path`);--> statement-breakpoint
CREATE INDEX `scriptRunWorkspaceIdIndex` ON `scriptRun` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `scriptRunStatusIndex` ON `scriptRun` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessionEventSessionSequenceUnique` ON `sessionEvent` (`sessionId`,`sequence`);--> statement-breakpoint
CREATE INDEX `workspaceProjectIdIndex` ON `workspace` (`projectId`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaceActivePathUnique` ON `workspace` (`path`) WHERE "workspace"."status" = 'active';