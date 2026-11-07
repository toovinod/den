import devChatTurns from "./fixtures/devChatTurns.json" with { type: "json" };
import { makeReplayAdapter } from "../agents/replay/ReplayAdapter.ts";
import { testAgentServices } from "./testAgentServices.ts";
import { AgentEvent } from "@repo/contracts/AgentEvent";
import { runDaemon } from "../server/runDaemon.ts";
import { Schema } from "effect";

// The real daemon with agents that replay recorded turns, for UI work without agent CLIs or keys.
// Run it with `bun run dev:replay` and type a token on the first line, as the desktop shell does.
const turns = Schema.decodeUnknownSync(Schema.Array(Schema.Array(AgentEvent)))(devChatTurns);

runDaemon(
	testAgentServices({
		claude: makeReplayAdapter({ kind: "claude", nativeSessionId: "dev-claude", turns }),
		codex: makeReplayAdapter({ kind: "codex", nativeSessionId: "dev-codex", turns }),
	}),
);
