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
			sendMessage: ({ sessionId, text, images, steer }) =>
				sessions.sendMessage(sessionId, text, images, steer).pipe(orInternalError("send the message")),
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
			setAgentAuthMode: ({ agent, mode }) =>
				sessions.setAuthMode(agent, mode).pipe(orInternalError("save the sign-in choice")),
			startAgentLogin: ({ agent }) => sessions.startLogin(agent).pipe(orInternalError("start the sign-in")),
			updateSessionSettings: ({ sessionId, model, effort }) =>
				sessions.updateSettings(sessionId, { model, effort }).pipe(orInternalError("change the model")),
			getAttachment: ({ sessionId, attachmentId }) =>
				sessions.getAttachment(sessionId, attachmentId).pipe(orInternalError("load the image")),
		});
	}),
);
