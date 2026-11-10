import { TrackedChildProcessSpawner } from "../processes/TrackedChildProcessSpawner.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { ClaudeAdapter } from "../agents/claude/ClaudeAdapter.ts";
import { TerminalService } from "../terminals/TerminalService.ts";
import { CodexAdapter } from "../agents/codex/CodexAdapter.ts";
import { CredentialStore } from "../agents/CredentialStore.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { SessionService } from "../sessions/SessionService.ts";
import { WorkspaceLock } from "../workspaces/WorkspaceLock.ts";
import { ClaudeQuery } from "../agents/claude/ClaudeQuery.ts";
import { LocalDatabase } from "../database/LocalDatabase.ts";
import { FileService } from "../files/FileService.ts";
import { BunServices } from "@effect/platform-bun";
import { GitService } from "../git/GitService.ts";
import { SecureRandom } from "effect/crypto";
import { Layer } from "effect";

// The real agent CLIs and the OS keychain. Tests provide replay adapters and in-memory keys instead.
export const AgentServices = Layer.mergeAll(
	ClaudeAdapter.layer.pipe(Layer.provide(ClaudeQuery.layer)),
	CodexAdapter.layer,
	CredentialStore.layer,
).pipe(Layer.provide(TrackedChildProcessSpawner), Layer.provide(BunServices.layer));

// The services behind the RPC handlers. Opening the database runs pending migrations,
// and starting the services recovers sessions and setup scripts cut off by a restart.
// Every child they spawn goes through the tracked spawner. The ProcessRegistry comes from
// outside, because the agent adapters record their children in the same one.
export const DaemonServices = Layer.mergeAll(GitService.layer, FileService.layer).pipe(
	Layer.provideMerge(WorkspaceService.layer),
	Layer.provideMerge(Layer.merge(SessionService.layer, TerminalService.layer)),
	Layer.provideMerge(Layer.merge(ProjectService.layer, WorkspaceLock.layer)),
	Layer.provide(TrackedChildProcessSpawner),
	Layer.provideMerge(LocalDatabase.layer),
	Layer.provide([BunServices.layer, SecureRandom.layerWebCrypto]),
);
