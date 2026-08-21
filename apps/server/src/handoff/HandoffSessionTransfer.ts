/**
 * HandoffSessionTransfer — provider dispatch for moving a session.
 *
 * The two supported providers keep their session in different shapes, so the
 * per-provider knowledge lives in their driver modules and this picks between
 * them. Everything above here deals in opaque bytes plus a filename.
 *
 * Complexity belongs at the adapter boundary: a provider that cannot move a
 * session returns null here rather than teaching the orchestration layer about
 * session storage.
 *
 * @module handoff/HandoffSessionTransfer
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  exportClaudeSession,
  installClaudeSession,
} from "../provider/Drivers/ClaudeSessionTransfer.ts";
import {
  exportCodexSession,
  installCodexSession,
} from "../provider/Drivers/CodexSessionTransfer.ts";

/** Provider kinds whose sessions can move. Everything else is unsupported. */
export type TransferableProvider = "claudeAgent" | "codex";

export function isTransferableProvider(provider: string): provider is TransferableProvider {
  return provider === "claudeAgent" || provider === "codex";
}

export interface HandoffSessionLocation {
  readonly provider: TransferableProvider;
  /** Claude: the resolved CLAUDE_CONFIG_DIR. Codex: the resolved CODEX_HOME. */
  readonly providerHome: string;
  /** The session/thread id the provider resumes by. */
  readonly sessionId: string;
  /** Working directory the session belongs to. Only Claude keys on this. */
  readonly cwd: string;
}

export interface ExportedHandoffSession {
  readonly bytes: Uint8Array;
  /** Present for Codex, whose rollout is found by filename. */
  readonly fileName?: string;
}

/**
 * Read the provider's session for transport. Null means "nothing to move",
 * which callers must treat as a refusal BEFORE stopping the user's session.
 */
export const exportHandoffSession = Effect.fn("HandoffSessionTransfer.exportHandoffSession")(
  function* (input: HandoffSessionLocation) {
    if (input.provider === "claudeAgent") {
      const exported = yield* exportClaudeSession({
        configDir: input.providerHome,
        cwd: input.cwd,
        sessionId: input.sessionId,
      });
      return exported === null
        ? null
        : ({ bytes: exported.bytes } satisfies ExportedHandoffSession);
    }
    const exported = yield* exportCodexSession({
      codexHome: input.providerHome,
      threadId: input.sessionId,
    });
    return exported === null
      ? null
      : ({ bytes: exported.bytes, fileName: exported.fileName } satisfies ExportedHandoffSession);
  },
);

/**
 * Place a transported session where this machine's provider will find it.
 * Returns the path written, for diagnostics.
 */
export const installHandoffSession = Effect.fn("HandoffSessionTransfer.installHandoffSession")(
  function* (
    input: HandoffSessionLocation & {
      readonly bytes: Uint8Array;
      readonly fileName?: string | undefined;
    },
  ) {
    if (input.provider === "claudeAgent") {
      return yield* installClaudeSession({
        configDir: input.providerHome,
        cwd: input.cwd,
        sessionId: input.sessionId,
        bytes: input.bytes,
      });
    }
    // Codex finds a rollout by the id in its filename, so a bundle without one
    // cannot be installed — rebuild the conventional name rather than guess.
    const fileName = input.fileName ?? `rollout-${input.sessionId}.jsonl`;
    return yield* installCodexSession({
      codexHome: input.providerHome,
      fileName,
      bytes: input.bytes,
    });
  },
);

/**
 * Whether this machine already holds the session a bundle describes. Used by
 * adopt to stay idempotent when a courier retries after a dropped connection.
 */
export const hasHandoffSession = Effect.fn("HandoffSessionTransfer.hasHandoffSession")(function* (
  input: HandoffSessionLocation & { readonly fileName?: string | undefined },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.provider === "codex") {
    const candidate = path.join(input.providerHome, "sessions", input.fileName ?? "");
    return yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  }
  const exported = yield* exportClaudeSession({
    configDir: input.providerHome,
    cwd: input.cwd,
    sessionId: input.sessionId,
  });
  return exported !== null;
});
