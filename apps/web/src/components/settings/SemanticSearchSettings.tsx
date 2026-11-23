import { T, useGT } from "gt-react";
import type { SemanticSearchStatus } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SemanticSearchStatusLine({ status }: { status: SemanticSearchStatus | null }) {
  const gt = useGT();
  if (status === null) {
    return (
      <span>
        <T>Checking status…</T>
      </span>
    );
  }
  switch (status.state) {
    case "disabled":
      return null;
    case "pending":
      return (
        <span>
          <T>Preparing the embedding model…</T>
        </span>
      );
    case "downloading": {
      const totalBytes = status.totalBytes ?? 0;
      const downloadedBytes = Math.min(status.downloadedBytes ?? 0, totalBytes);
      const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
      return (
        <div className="flex max-w-xs flex-col gap-1.5">
          <span>
            <T>
              Downloading model
              {totalBytes > 0
                ? gt(": {downloaded} of {total}", {
                    downloaded: formatMegabytes(downloadedBytes),
                    total: formatMegabytes(totalBytes),
                  })
                : "…"}
            </T>
          </span>
          <div
            role="progressbar"
            aria-label={gt("Model download progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      );
    }
    case "ready":
      return status.pendingMessages > 0 ? (
        <span>
          <T>
            Indexing chats: {status.pendingMessages.toLocaleString()} to go (
            {status.indexedMessages.toLocaleString()} done). Search improves as it fills in.
          </T>
        </span>
      ) : (
        <span>
          <T>Ready. {status.indexedMessages.toLocaleString()} messages indexed.</T>
        </span>
      );
    case "error":
      return (
        <span className="text-destructive">
          <T>
            {status.errorMessage ?? gt("The embedding model failed to load.")} It will retry
            automatically.
          </T>
        </span>
      );
  }
}

export function SemanticSearchSettingRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const enabled = settings.semanticSearchEnabled;

  const { data: status } = useEnvironmentQuery(
    enabled && environmentId !== null
      ? serverEnvironment.semanticSearchStatus({ environmentId, input: {} })
      : null,
  );

  return (
    <SettingsRow
      {...searchableSetting("semantic-search")}
      description={gt(
        "Find chats by meaning instead of exact words. Enabling downloads a small embedding model (~25 MB) once and indexes your chats locally; nothing leaves this machine.",
      )}
      status={enabled ? <SemanticSearchStatusLine status={status ?? null} /> : null}
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => updateSettings({ semanticSearchEnabled: Boolean(checked) })}
          aria-label={gt("Semantic search")}
        />
      }
    />
  );
}
