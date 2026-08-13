import type { SemanticSearchStatus } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SemanticSearchStatusLine({ status }: { status: SemanticSearchStatus | null }) {
  if (status === null) {
    return <span>Checking status…</span>;
  }
  switch (status.state) {
    case "disabled":
      return null;
    case "pending":
      return <span>Preparing the embedding model…</span>;
    case "downloading": {
      const totalBytes = status.totalBytes ?? 0;
      const downloadedBytes = Math.min(status.downloadedBytes ?? 0, totalBytes);
      const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
      return (
        <div className="flex max-w-xs flex-col gap-1.5">
          <span>
            Downloading model
            {totalBytes > 0
              ? ` — ${formatMegabytes(downloadedBytes)} of ${formatMegabytes(totalBytes)}`
              : "…"}
          </span>
          <div
            role="progressbar"
            aria-label="Model download progress"
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
          Indexing chats — {status.pendingMessages.toLocaleString()} to go (
          {status.indexedMessages.toLocaleString()} done). Search improves as it fills in.
        </span>
      ) : (
        <span>Ready — {status.indexedMessages.toLocaleString()} messages indexed.</span>
      );
    case "error":
      return (
        <span className="text-destructive">
          {status.errorMessage ?? "The embedding model failed to load."} It will retry
          automatically.
        </span>
      );
  }
}

export function SemanticSearchSettingRow() {
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
      description="Find chats by meaning instead of exact words. Enabling downloads a small embedding model (~25 MB) once and indexes your chats locally; nothing leaves this machine."
      status={enabled ? <SemanticSearchStatusLine status={status ?? null} /> : null}
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => updateSettings({ semanticSearchEnabled: Boolean(checked) })}
          aria-label="Semantic search"
        />
      }
    />
  );
}
