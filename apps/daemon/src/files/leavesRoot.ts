import { isAbsolute, sep } from "node:path";

// True when a path relative to a folder points outside it. `..foo` is a name inside the folder,
// so only a whole `..` segment counts.
export const leavesRoot = (relativePath: string) =>
	relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
