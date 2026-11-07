#!/usr/bin/env bun
// A stand-in for the codex CLI in tests. It answers `--version` and speaks a small,
// scripted slice of the app-server protocol. The user's message picks the script:
// "approve" asks for a command approval, "ask" sends a request Den does not support,
// anything else streams a short reply.
import codexVersion from "../generated/CODEX_VERSION" with { type: "text" };

type Answer = {
	result?: { decision?: string };
	error?: { code: number; message: string };
};

const out = Bun.stdout.writer();
const send = (message: object) => {
	out.write(`${JSON.stringify(message)}\n`);
	out.flush();
};

const threadId = "thread-new";
const turnId = "turn-1";
const waiting = new Map<number, (answer: Answer) => void>();

const notify = (method: string, params: object) => send({ method, params });

const completeTurn = (status: string) =>
	notify("turn/completed", {
		threadId,
		turn: { id: turnId, status, error: null, items: [] },
	});

const command = {
	type: "commandExecution",
	id: "cmd-1",
	command: "bun test",
	cwd: "/repo",
	status: "inProgress",
	aggregatedOutput: null,
};

const ask = (id: number, method: string, params: object) =>
	new Promise<Answer>((resolve) => {
		waiting.set(id, resolve);
		send({ id, method, params });
	});

const runTurn = async (
	text: string,
	params: { model?: string; effort?: string | null; input: Array<{ type: string; path?: string }> },
) => {
	if (text.includes("images")) {
		notify("item/completed", {
			item: { type: "agentMessage", id: "msg-1", text: JSON.stringify(params.input.slice(1)) },
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	if (text.includes("usage")) {
		notify("thread/tokenUsage/updated", {
			threadId,
			turnId,
			tokenUsage: {
				total: {
					totalTokens: 9000,
					inputTokens: 0,
					cachedInputTokens: 0,
					cacheWriteInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
				},
				last: {
					totalTokens: 1200,
					inputTokens: 0,
					cachedInputTokens: 0,
					cacheWriteInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
				},
				modelContextWindow: 272000,
			},
		});
		notify("account/rateLimits/updated", {
			rateLimits: {
				limitId: null,
				limitName: null,
				primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1700000000 },
				secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null },
				credits: null,
				planType: null,
				rateLimitReachedType: null,
			},
		});
		return completeTurn("completed");
	}
	if (text.includes("settings")) {
		notify("item/completed", {
			item: { type: "agentMessage", id: "msg-1", text: `${params.model}/${params.effort}` },
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	if (text.includes("approve")) {
		notify("item/started", { item: command, threadId, turnId });
		const answer = await ask(100, "item/commandExecution/requestApproval", {
			threadId,
			turnId,
			itemId: "cmd-1",
			command: "bun test",
			reason: "Run the tests",
		});
		const decision = answer.result?.decision;
		// A cancelled approval is followed by turn/interrupt, which ends the turn.
		if (decision === "cancel") return;
		notify("item/completed", {
			item: {
				...command,
				status: decision === "accept" ? "completed" : "declined",
				aggregatedOutput: decision === "accept" ? "3 pass" : null,
			},
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	if (text.includes("ask")) {
		const answer = await ask(200, "item/tool/requestUserInput", {
			threadId,
			turnId,
		});
		notify("item/completed", {
			item: {
				type: "agentMessage",
				id: "msg-1",
				text: `error ${answer.error?.code}`,
			},
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	for (const delta of ["Hel", "lo"]) {
		notify("item/agentMessage/delta", {
			threadId,
			turnId,
			itemId: "msg-1",
			delta,
		});
	}
	notify("item/completed", {
		item: { type: "agentMessage", id: "msg-1", text: "Hello" },
		threadId,
		turnId,
	});
	completeTurn("completed");
};

// Den must pin these, or the user's own Codex config could turn approvals off.
const hasDenPolicy = (params: { approvalPolicy?: string; sandbox?: string }) =>
	params.approvalPolicy === "on-request" && params.sandbox === "workspace-write";

const serve = async () => {
	for await (const line of console) {
		if (line.trim() === "") continue;
		const message = JSON.parse(line);
		if (message.method === undefined) {
			waiting.get(message.id)?.(message);
			waiting.delete(message.id);
			continue;
		}
		switch (message.method) {
			case "initialize":
				send({ id: message.id, result: { userAgent: "fake" } });
				break;
			case "account/read":
				send({
					id: message.id,
					result: {
						account: { type: "chatgpt", email: "dev@example.com" },
						requiresOpenaiAuth: true,
					},
				});
				break;
			case "account/login/start":
				send({
					id: message.id,
					result: { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example/login" },
				});
				setTimeout(() => notify("account/login/completed", { loginId: "login-1", success: true, error: null }), 50);
				break;
			case "model/list":
				send({
					id: message.id,
					result: message.params.cursor
						? {
								data: [
									{
										id: "gpt-later",
										displayName: "GPT Later",
										description: "A test model",
										supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
										defaultReasoningEffort: "low",
										inputModalities: ["text"],
										isDefault: false,
									},
								],
								nextCursor: null,
							}
						: {
								data: [
									{
										id: "gpt-first",
										displayName: "GPT First",
										description: "A test model",
										supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
										defaultReasoningEffort: "low",
										inputModalities: ["text", "image"],
										isDefault: true,
									},
								],
								nextCursor: "page-2",
							},
				});
				break;
			case "thread/start":
			case "thread/resume":
				if (!hasDenPolicy(message.params)) {
					send({
						id: message.id,
						error: { code: -32602, message: "approval policy not pinned" },
					});
					break;
				}
				if (message.method === "thread/start") {
					send({ id: message.id, result: { thread: { id: threadId } } });
					break;
				}
				send({
					id: message.id,
					result: { thread: { id: message.params.threadId } },
				});
				break;
			case "turn/start":
				send({ id: message.id, result: { turn: { id: turnId } } });
				void runTurn(message.params.input[0].text, message.params);
				break;
			case "turn/interrupt":
				send({ id: message.id, result: {} });
				completeTurn("interrupted");
				break;
		}
	}
};

if (Bun.argv.includes("--version")) {
	out.write(`codex-cli ${codexVersion.trim()}\n`);
	out.flush();
} else {
	await serve();
}
