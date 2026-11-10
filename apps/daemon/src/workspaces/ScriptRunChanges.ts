import type { ScriptRun } from "@repo/contracts/ScriptRun";
import { Context, Layer, PubSub } from "effect";

// A slow client loses the oldest changes rather than growing the daemon's memory.
const KEPT_CHANGES = 256;

// Every script run status change, published where the change is written, so clients see a run start
// and end without polling.
export class ScriptRunChanges extends Context.Service<ScriptRunChanges, PubSub.PubSub<ScriptRun>>()(
	"den/daemon/workspaces/ScriptRunChanges",
) {
	static readonly layer = Layer.effect(ScriptRunChanges, PubSub.sliding<ScriptRun>(KEPT_CHANGES));
}
