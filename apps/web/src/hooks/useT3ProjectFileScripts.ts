import {
  SLOP_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface T3ProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: T3ProjectFile | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
}

export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  // `slop.json` wins; legacy `t3.json` is only read once `slop.json` is known to be missing.
  const slopQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    SLOP_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const slopContents = slopQuery.data && !slopQuery.data.truncated ? slopQuery.data.contents : null;
  const slopMissing = !slopQuery.isPending && slopContents === null;
  const t3Query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    T3_PROJECT_FILE_NAME,
    cwd !== null && slopMissing,
  );
  const t3Contents = t3Query.data && !t3Query.data.truncated ? t3Query.data.contents : null;
  const contents = slopContents ?? (slopMissing ? t3Contents : null);
  const isPending = slopQuery.isPending || (slopMissing && t3Query.isPending);
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
    } as const;
  }
  const file = parseT3ProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
}

export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useT3ProjectFileState(environmentId, cwd).scripts;
}
