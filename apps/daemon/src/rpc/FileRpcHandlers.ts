import { orInternalError } from "./orInternalError.ts";
import { FileService } from "../files/FileService.ts";
import { FileRpcs } from "@repo/contracts/FileRpcs";
import { Effect } from "effect";

export const FileRpcHandlers = FileRpcs.toLayer(
	Effect.gen(function* () {
		const files = yield* FileService;
		return FileRpcs.of({
			listDirectory: ({ workspaceId, path }) =>
				files.listDirectory(workspaceId, path).pipe(orInternalError("list the files")),
			readFile: ({ workspaceId, path }) => files.readFile(workspaceId, path).pipe(orInternalError("read the file")),
		});
	}),
);
