import {
  machineHandoffBanner,
  type MachineHandoffBannerAction,
} from "@t3tools/client-runtime/machine-handoff";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useMachineHandoffProgress } from "../../state/machine-handoff";
import { useMachineHandoffActions } from "./useMachineHandoffActions";

const ACTION_LABELS: Record<MachineHandoffBannerAction, string> = {
  cancel: "Cancel",
  continue: "Continue",
  retry: "Retry",
  "hand-back": "Hand back",
  "take-back": "Take back",
};

/** Above the composer for a thread that is moving, moved, or arrived from another machine. */
export function MachineHandoffBanner(props: { readonly thread: EnvironmentThreadShell }) {
  const progress = useMachineHandoffProgress(props.thread.machineHandoff?.id ?? null);
  const actions = useMachineHandoffActions(props.thread);
  const banner = machineHandoffBanner(props.thread, progress);
  if (banner === null) return null;

  const onPress = (action: MachineHandoffBannerAction) => {
    switch (action) {
      case "cancel":
        void actions.cancelHandoff();
        return;
      case "take-back":
        actions.takeBack();
        return;
      case "hand-back":
        void actions.run({ type: "hand-back" }, "Could not hand the thread back");
        return;
      case "continue":
      case "retry":
        void actions.run({ type: action }, "Handoff failed");
        return;
    }
  };

  return (
    <View className="flex-row items-start gap-2 px-4 pb-2">
      <SymbolView
        name="arrow.left.arrow.right"
        size={12}
        tintColorClassName={
          banner.tone === "warning" ? "accent-warning-foreground" : "accent-foreground-muted"
        }
      />
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-foreground" numberOfLines={1}>
          {banner.title}
        </Text>
        {banner.description === null ? null : (
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {banner.description}
          </Text>
        )}
      </View>
      {banner.actions.map((action) => (
        <Pressable
          key={action}
          accessibilityRole="button"
          onPress={() => onPress(action)}
          hitSlop={8}
          className="min-h-8 justify-center px-1 active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-primary">{ACTION_LABELS[action]}</Text>
        </Pressable>
      ))}
    </View>
  );
}
