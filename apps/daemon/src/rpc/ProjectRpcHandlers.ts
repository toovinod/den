import { ProjectRpcs } from "@repo/contracts/ProjectRpcs";
import { Effect } from "effect";
import { ProjectService } from "../projects/ProjectService.ts";
import { orInternalError } from "./orInternalError.ts";

export const ProjectRpcHandlers = ProjectRpcs.toLayer(
	Effect.gen(function* () {
		const projects = yield* ProjectService;
		return ProjectRpcs.of({
			addProject: ({ path }) => projects.add(path).pipe(orInternalError("add the project")),
			listProjects: () => projects.list.pipe(orInternalError("list projects")),
			removeProject: ({ projectId }) => projects.remove(projectId).pipe(orInternalError("remove the project")),
			updateProjectScripts: ({ projectId, setupScript, runScript }) =>
				projects.updateScripts(projectId, { setupScript, runScript }).pipe(orInternalError("save the project scripts")),
		});
	}),
);
