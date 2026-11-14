import { type EffortLevel, type Options, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Context, Layer } from "effect";

// One running query. Messages are left unknown on purpose: the adapter decodes the fields it
// uses with Schema, so a fake in tests can send plain objects.
export interface ClaudeQueryRun {
	readonly messages: AsyncIterable<unknown>;
	interrupt(): Promise<unknown>;
	setModel(model: string): Promise<void>;
	setEffort(effort: EffortLevel | null): Promise<void>;
	close(): void;
}

export class ClaudeQuery extends Context.Service<
	ClaudeQuery,
	{
		start(params: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }): ClaudeQueryRun;
	}
>()("octopus/daemon/agents/claude/ClaudeQuery") {
	static readonly layer = Layer.succeed(
		ClaudeQuery,
		ClaudeQuery.of({
			start: (params) => {
				const run = query(params);
				return {
					messages: run,
					interrupt: () => run.interrupt(),
					setModel: (model) => run.setModel(model),
					setEffort: (effortLevel) => run.applyFlagSettings({ effortLevel }),
					close: () => run.close(),
				};
			},
		}),
	);
}
