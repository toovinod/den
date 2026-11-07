import recordingJson from "../agents/replay/fixtures/commandWithApproval.json" with { type: "json" };
import { makeReplayAdapter, Recording } from "../agents/replay/ReplayAdapter.ts";
import { memoryCredentialStore } from "./memoryCredentialStore.ts";
import { ClaudeAdapter } from "../agents/claude/ClaudeAdapter.ts";
import { CodexAdapter } from "../agents/codex/CodexAdapter.ts";
import type { AgentAdapter } from "../agents/AgentAdapter.ts";
import { Effect, Layer, Schema } from "effect";

export const commandWithApproval = Schema.decodeUnknownSync(Recording)(recordingJson);

export const TEST_LOGIN_URL = "https://auth.example/login";

// Replayed agents and in-memory keys, so tests never start a real agent or touch the keychain.
export const testAgentServices = (
	adapters: { readonly claude: AgentAdapter; readonly codex: AgentAdapter } = {
		claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }),
		codex: makeReplayAdapter(commandWithApproval),
	},
) =>
	Layer.mergeAll(
		Layer.succeed(ClaudeAdapter, adapters.claude),
		Layer.succeed(CodexAdapter, { startLogin: Effect.succeed(TEST_LOGIN_URL), ...adapters.codex }),
		memoryCredentialStore,
	);
