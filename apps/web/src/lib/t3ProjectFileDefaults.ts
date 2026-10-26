import { T3_PROJECT_FILE_NAMES, type EnvironmentId, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  for (const fileName of T3_PROJECT_FILE_NAMES) {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, fileName),
      { reportDefect: false, reportFailure: false },
    );
    const data = resolveProjectFileQueryData(
      environmentId,
      workspaceRoot,
      fileName,
      result._tag === "Success" ? result.value : null,
    );
    if (data === null || data.exists === false || data.truncated) continue;
    // Matches the server loader: the first existing file wins outright, even
    // when its contents fail to parse.
    return parseT3ProjectFile(data.contents);
  }
  return null;
}
