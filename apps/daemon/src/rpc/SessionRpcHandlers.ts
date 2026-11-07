import { SessionRpcs } from "@repo/contracts/SessionRpcs";
import { Effect, Stream } from "effect";

// Placeholders until SessionService lands. Calls fail as defects.
const notYet = (name: string) => () => Effect.die(`${name} is not implemented yet`);
const notYetStream = (name: string) => () => Stream.die(`${name} is not implemented yet`);

export const SessionRpcHandlers = SessionRpcs.toLayer({
	listAgents: notYet("listAgents"),
	setAgentApiKey: notYet("setAgentApiKey"),
	removeAgentApiKey: notYet("removeAgentApiKey"),
	createSession: notYet("createSession"),
	listSessions: notYet("listSessions"),
	renameSession: notYet("renameSession"),
	sendMessage: notYet("sendMessage"),
	respondToApproval: notYet("respondToApproval"),
	interruptSession: notYet("interruptSession"),
	stopSession: notYet("stopSession"),
	subscribeSession: notYetStream("subscribeSession"),
	watchSessions: notYetStream("watchSessions"),
});
