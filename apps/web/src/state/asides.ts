import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { createAtomCommandScheduler } from "@t3tools/client-runtime/state/runtime";
import { ASIDE_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const commandScheduler = createAtomCommandScheduler();

/**
 * Asides are commands rather than cached queries in both directions.
 *
 * `ask` obviously mutates, but `list` is a command too: an aside is only ever
 * written by this client, so there is nothing to poll for, and a cached query
 * would have to be invalidated on every ask anyway. The panel reads once when
 * it opens and then keeps whatever `ask` hands back.
 */
export const asideEnvironment = {
  list: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:asides:list",
    tag: ASIDE_WS_METHODS.list,
    scheduler: commandScheduler,
  }),
  /**
   * The panel disables its send button while a question is in flight, so
   * ordering is enforced there rather than by a concurrency key here. Message
   * order is a server-side property regardless — see the aside read path.
   */
  ask: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:asides:ask",
    tag: ASIDE_WS_METHODS.ask,
    scheduler: commandScheduler,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:asides:remove",
    tag: ASIDE_WS_METHODS.remove,
    scheduler: commandScheduler,
  }),
};
