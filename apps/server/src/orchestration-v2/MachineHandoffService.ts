import type { MachineHandoffId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A handoff step that could not finish; `message` is shown to the user. */
export class MachineHandoffError extends Schema.TaggedError<MachineHandoffError>()(
  "MachineHandoffError",
  {
    message: Schema.String,
    /** Worth retrying as is, such as a thread that has not finished stopping. */
    retryable: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface MachineHandoffServiceShape {
  /** Stages a stopped thread's work and marks the handoff ready. */
  readonly exportBundle: (input: {
    readonly threadId: ThreadId;
    readonly handoffId: MachineHandoffId;
  }) => Effect.Effect<void, MachineHandoffError>;
  /** Best-effort removal of a cancelled handoff's staged bundle and refs. */
  readonly cleanup: (input: {
    readonly threadId: ThreadId;
    readonly handoffId: MachineHandoffId;
  }) => Effect.Effect<void>;
}

export class MachineHandoffService extends Context.Service<
  MachineHandoffService,
  MachineHandoffServiceShape
>()("t3/orchestration-v2/MachineHandoffService") {}
