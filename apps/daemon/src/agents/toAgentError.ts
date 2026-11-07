import { AgentNotInstalledError, AgentProcessError } from "./AgentAdapter.ts";
import type { PlatformError } from "effect";

// A missing executable is permanent, anything else about the process may pass.
export const toAgentError = (executable: string, message: string) => (error: PlatformError.PlatformError) =>
	error.reason._tag === "NotFound"
		? new AgentNotInstalledError({ executable })
		: new AgentProcessError({ message, cause: error });
