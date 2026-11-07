import { SessionService } from "../sessions/SessionService.ts";
import { SessionRpcs } from "@repo/contracts/SessionRpcs";
import { orInternalError } from "./orInternalError.ts";
import { Effect, Stream } from "effect";

export const SessionRpcHandlers = SessionRpcs.toLayer(
	Effect.gen(function* () {
		const sessions = yield* SessionService;
		return SessionRpcs.of({
			listAgents: () => sessions.listAgents.pipe(orInternalError("list agents")),
			setAgentApiKey: ({ agent, apiKey }) =>
				sessions.setApiKey(agent, apiKey).pipe(orInternalError("save the API key")),
			removeAgentApiKey: ({ agent }) => sessions.removeApiKey(agent).pipe(orInternalError("remove the API key")),
			createSession: (input) => sessions.create(input).pipe(orInternalError("create the chat")),
			listSessions: ({ workspaceId }) => sessions.list(workspaceId).pipe(orInternalError("list chats")),
			renameSession: ({ sessionId, title }) =>
				sessions.rename(sessionId, title).pipe(orInternalError("rename the chat")),
			sendMessage: ({ sessionId, text, steer }) =>
				sessions.sendMessage(sessionId, text, steer).pipe(orInternalError("send the message")),
			respondToApproval: ({ sessionId, requestId, decision }) =>
				sessions.respondToApproval(sessionId, requestId, decision).pipe(orInternalError("answer the approval")),
			interruptSession: ({ sessionId }) => sessions.interrupt(sessionId).pipe(orInternalError("stop the turn")),
			stopSession: ({ sessionId }) => sessions.stop(sessionId).pipe(orInternalError("stop the agent")),
			subscribeSession: ({ sessionId, afterSequence }) =>
				sessions
					.subscribe(sessionId, afterSequence)
					.pipe(
						Stream.catchTag("LocalDatabaseError", (error) =>
							Stream.fromEffect(Effect.fail(error).pipe(orInternalError("load the chat"))),
						),
					),
			watchSessions: () => sessions.watch,
			setAgentAuthMode: () => Effect.die("setAgentAuthMode is not implemented yet"),
			startAgentLogin: () => Effect.die("startAgentLogin is not implemented yet"),
			updateSessionSettings: () => Effect.die("updateSessionSettings is not implemented yet"),
			getAttachment: () => Effect.die("getAttachment is not implemented yet"),
		});
	}),
);
