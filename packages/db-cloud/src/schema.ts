import { authRelations } from "./authSchema.ts";
import { cloudWorkspaceRelations } from "./cloudWorkspace.ts";

export * from "./authSchema.ts";
export * from "./cloudWorkspace.ts";

export const relations = { ...authRelations, ...cloudWorkspaceRelations };
