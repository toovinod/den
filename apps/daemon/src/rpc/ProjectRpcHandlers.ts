import { ProjectService } from "../projects/ProjectService.ts";
import { ProjectRpcs } from "@repo/contracts/ProjectRpcs";
import { orInternalError } from "./orInternalError.ts";
import { Effect } from "effect";

export const ProjectRpcHandlers = ProjectRpcs.toLayer(
	Effect.gen(function* () {
		const projects = yield* ProjectService;
		return ProjectRpcs.of({
			addProject: ({ path }) => projects.add(path).pipe(orInternalError("add the project")),
			listProjects: () => projects.list.pipe(orInternalError("list projects")),
			removeProject: ({ projectId }) => projects.remove(projectId).pipe(orInternalError("remove the project")),
			setProjectTrust: ({ projectId, trusted }) =>
				projects.setTrust(projectId, trusted).pipe(orInternalError("save the project trust setting")),
			updateProjectScripts: ({ projectId, setupScript, runScript }) =>
				projects.updateScripts(projectId, { setupScript, runScript }).pipe(orInternalError("save the project scripts")),
		});
	}),
);
