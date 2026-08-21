/**
 * HandoffProviderHome — where a provider instance keeps its sessions.
 *
 * A handoff reads bytes out of one machine's provider home and writes them
 * into another's, so both ends need the same answer the driver would give when
 * it spawns the CLI. Resolving it from settings rather than from a running
 * provider instance keeps adopt working on a machine where the thread does not
 * exist yet.
 *
 * @module handoff/HandoffProviderHome
 */
import { ClaudeSettings, CodexSettings, type ProviderInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { isTransferableProvider, type TransferableProvider } from "./HandoffSessionTransfer.ts";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

export interface ResolvedProviderHome {
  readonly provider: TransferableProvider;
  readonly providerHome: string;
}

/**
 * Resolve the session home for a configured provider instance, or null when
 * the instance is on a provider whose sessions cannot move.
 */
export const resolveHandoffProviderHome = Effect.fn("HandoffProviderHome.resolve")(function* (
  instance: ProviderInstanceConfig,
): Effect.fn.Return<ResolvedProviderHome | null, never, Path.Path> {
  if (!isTransferableProvider(instance.driver)) {
    return null;
  }

  if (instance.driver === "claudeAgent") {
    const settings = decodeClaudeSettings(instance.config ?? {});
    const providerHome = yield* resolveClaudeHomePath(settings);
    return { provider: "claudeAgent", providerHome };
  }

  const settings = decodeCodexSettings(instance.config ?? {});
  const layout = yield* resolveCodexHomeLayout(settings);
  // Sessions live in the shared home even when an instance runs behind a
  // shadow home: the overlay exists to isolate auth, not history.
  return { provider: "codex", providerHome: layout.sharedHomePath };
});
