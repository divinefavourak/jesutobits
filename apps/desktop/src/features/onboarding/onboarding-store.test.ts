import { describe, expect, it, vi } from "vitest";
import { MockHostBridge } from "../../host-bridge";
import { createOnboardingStore, ONBOARDING_KEY, ONBOARDING_STEPS } from "./onboarding-store";

describe("onboarding progress (FR-001, J-01)", () => {
  it("starts at the welcome step on a first run", async () => {
    const onboarding = createOnboardingStore(new MockHostBridge());
    expect(onboarding.getState().status).toBe("loading");
    await vi.waitFor(() => expect(onboarding.getState().status).toBe("active"));
    expect(onboarding.getState().step).toBe(0);
  });

  it("saves every move, so a restart resumes at the same step", async () => {
    const bridge = new MockHostBridge();
    const first = createOnboardingStore(bridge);
    await vi.waitFor(() => expect(first.getState().status).toBe("active"));
    first.getState().next();
    first.getState().next();
    first.getState().back();
    first.getState().next();
    expect((await bridge.uiState.get())[ONBOARDING_KEY]).toEqual({ step: 2, completed: false });

    const second = createOnboardingStore(bridge);
    await vi.waitFor(() => expect(second.getState().status).toBe("active"));
    expect(second.getState().step).toBe(2);
  });

  it("stays within the steps", async () => {
    const onboarding = createOnboardingStore(new MockHostBridge());
    await vi.waitFor(() => expect(onboarding.getState().status).toBe("active"));
    onboarding.getState().back();
    expect(onboarding.getState().step).toBe(0);
    for (let i = 0; i < 20; i += 1) onboarding.getState().next();
    expect(onboarding.getState().step).toBe(ONBOARDING_STEPS.length - 1);
  });

  it("is not shown again once finished", async () => {
    const bridge = new MockHostBridge();
    const first = createOnboardingStore(bridge);
    await vi.waitFor(() => expect(first.getState().status).toBe("active"));
    first.getState().finish();
    expect(first.getState().status).toBe("done");

    const second = createOnboardingStore(bridge);
    await vi.waitFor(() => expect(second.getState().status).toBe("done"));
  });

  it("starts over when the stored progress does not validate", async () => {
    const bridge = new MockHostBridge();
    await bridge.uiState.update({ [ONBOARDING_KEY]: { step: 99, completed: "yes" } });
    const onboarding = createOnboardingStore(bridge);
    await vi.waitFor(() => expect(onboarding.getState().status).toBe("active"));
    expect(onboarding.getState().step).toBe(0);
  });
});
