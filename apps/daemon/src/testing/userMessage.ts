import type { UserMessage } from "../agents/AgentAdapter.ts";

// A text-only message for adapter tests.
export const userMessage = (text: string): UserMessage => ({ id: `message-${text}`, text, images: [] });
