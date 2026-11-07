import { ProjectFolderName } from "@repo/contracts/Project";
import { WorkspaceName } from "@repo/contracts/Workspace";
import { Schema } from "effect";

// The daemon's own rules, checked as the user types so the form can say what is wrong before sending.
export const isWorkspaceName = Schema.is(WorkspaceName);
export const isProjectFolderName = Schema.is(ProjectFolderName);
