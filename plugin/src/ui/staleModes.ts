/**
 * Shared display text for StaleConfiguredMode warnings — used by both
 * PushDiff.tsx and PullDiff.tsx, so the copy can't drift between the two
 * views the same way the underlying detection logic once did between push
 * and pull (see sync-logic.ts's findStaleConfiguredModes).
 */
import type { StaleConfiguredMode } from "../shared/sync-logic";

const STALE_ROLE_LABEL: Record<StaleConfiguredMode["role"], string> = {
  themes: "Theme",
  colorSchemes: "Color Scheme",
  sizes: "Size",
};

export function describeStaleModes(modes: StaleConfiguredMode[]): string {
  return modes.map((m) => `"${m.name}" (${STALE_ROLE_LABEL[m.role]})`).join(", ");
}
