import { cloudWorkspaceRelations } from "./cloudWorkspace.ts";
import { authRelations } from "./authSchema.ts";

export * from "./authSchema.ts";
export * from "./cloudWorkspace.ts";

export const relations = { ...authRelations, ...cloudWorkspaceRelations };
