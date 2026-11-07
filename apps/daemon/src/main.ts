import { AgentServices } from "./server/DaemonServices.ts";
import { runDaemon } from "./server/runDaemon.ts";

runDaemon(AgentServices);
