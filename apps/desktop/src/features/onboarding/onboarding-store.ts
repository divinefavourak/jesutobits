import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostBridge } from "../../host-bridge";

/** The seven steps of UX_AND_INTERFACE.md section 3, in order. */
export const ONBOARDING_STEPS = [
  "welcome",
  "workspace",
  "toolchain",
  "provider",
  "credentials",
  "look",
  "project",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Every step but the workspace folder can be skipped (FR-001). */
export const SKIPPABLE: ReadonlySet<OnboardingStep> = new Set(
  ONBOARDING_STEPS.filter((step) => step !== "welcome" && step !== "workspace"),
);

/** The `ui-state.json` key; quitting mid-way resumes at the same step (J-01). */
export const ONBOARDING_KEY = "onboarding";

const StoredSchema = z.object({
  step: z
    .number()
    .int()
    .min(0)
    .max(ONBOARDING_STEPS.length - 1),
  completed: z.boolean(),
});

export interface OnboardingState {
  /** `loading` until ui-state has been read, so the start screen never flashes first. */
  status: "loading" | "active" | "done";
  step: number;
  next(): void;
  back(): void;
  /** Ends onboarding; it is not shown again. */
  finish(): void;
}

export type OnboardingStore = StoreApi<OnboardingState>;

/** First-run onboarding (FR-001, J-01): which step, saved after every move. */
export function createOnboardingStore(bridge: HostBridge): OnboardingStore {
  const store = createStore<OnboardingState>()((set, get) => {
    const save = (step: number, completed: boolean) =>
      bridge.uiState
        .update({ [ONBOARDING_KEY]: { step, completed } })
        .catch((error: unknown) =>
          bridge.log("warn", `saving onboarding progress failed: ${String(error)}`),
        );
    const go = (step: number) => {
      const clamped = Math.min(ONBOARDING_STEPS.length - 1, Math.max(0, step));
      set({ step: clamped });
      void save(clamped, false);
    };
    return {
      status: "loading",
      step: 0,
      next: () => go(get().step + 1),
      back: () => go(get().step - 1),
      finish: () => {
        set({ status: "done" });
        void save(get().step, true);
      },
    };
  });

  void bridge.uiState.get().then(
    (uiState) => {
      const stored = StoredSchema.safeParse(uiState[ONBOARDING_KEY]);
      if (stored.success && stored.data.completed) store.setState({ status: "done" });
      else store.setState({ status: "active", step: stored.success ? stored.data.step : 0 });
    },
    // Without ui-state, show onboarding from the start rather than nothing.
    () => store.setState({ status: "active", step: 0 }),
  );

  return store;
}
