import type { ModelInfo } from "@jesutobits/protocol";
import { useEffect, useId, useState } from "react";
import { t } from "../../i18n";
import { useAgent, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";
import { OpenRouterMark } from "../../ui/Studio";
import { OPENROUTER_REF } from "./agent-store";

/**
 * The OpenRouter key (FR-021, FR-023): typed into VS Code's own password box, so it never
 * enters the webview, and kept in SecretStorage (ADR-0015, invariant 3). Test connection
 * reports a categorised result in plain words.
 */
export function KeyForm({ onSaved }: { onSaved?: () => void }) {
  const { bridge, agent } = useWorkbench();
  const hasKey = useAgent((state) => state.hasKey);
  const [status, setStatus] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  const hintId = useId();

  useEffect(() => {
    void agent.getState().checkKey();
  }, [agent]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await work();
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      void agent.getState().checkKey();
    }
  };

  const runTest = async () => {
    const result = await bridge.rpc("models.testConnection", {});
    if (result.ok) {
      setStatus({ tone: "ok", text: t("settings.providers.testOk") });
      void agent.getState().loadModels(true);
    } else {
      setStatus({ tone: "error", text: result.error?.message ?? "" });
    }
  };

  const test = () => act(runTest);

  const enter = () =>
    act(async () => {
      if (!(await bridge.secrets.prompt(OPENROUTER_REF))) return;
      onSaved?.();
      await runTest();
    });

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
      <span id={labelId} className="font-medium">
        {t("settings.providers.key")}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={hasKey ? "secondary" : "primary"}
          disabled={busy}
          aria-describedby={hintId}
          onClick={() => void enter()}
        >
          {hasKey ? t("settings.providers.replace") : t("settings.providers.save")}
        </Button>
        <Button disabled={busy || hasKey !== true} onClick={() => void test()}>
          {busy ? t("settings.providers.testing") : t("settings.providers.test")}
        </Button>
        {hasKey && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void act(() => bridge.secrets.delete(OPENROUTER_REF))}
          >
            {t("settings.providers.remove")}
          </Button>
        )}
      </div>
      <p id={hintId} className="m-0 text-text-muted">
        {hasKey === null
          ? ""
          : hasKey
            ? t("settings.providers.keyStored")
            : t("settings.providers.keyMissing")}{" "}
        {t("settings.providers.keyHint")}
      </p>
      {status && (
        <p
          role={status.tone === "error" ? "alert" : "status"}
          className={`m-0 ${status.tone === "error" ? "text-danger" : "text-text"}`}
        >
          {status.text}
        </p>
      )}
    </div>
  );
}

/**
 * Connecting OpenRouter without knowing what an API key is: Sign in with OpenRouter opens the
 * browser and the extension stores the key OpenRouter makes; pasting a key stays possible.
 */
export function ConnectButtons({ onStored }: { onStored?: () => void }) {
  const { bridge, agent } = useWorkbench();
  const connect = (how: "signIn" | "prompt") =>
    void bridge.secrets[how](OPENROUTER_REF)
      .then(async (stored) => {
        await agent.getState().checkKey();
        if (stored) onStored?.();
      })
      .catch(() => undefined);
  return (
    <>
      <Button onClick={() => connect("signIn")}>
        <OpenRouterMark size={12} />
        {t("agent.key.signIn")}
      </Button>
      <Button variant="ghost" onClick={() => connect("prompt")}>
        {t("agent.key.paste")}
      </Button>
    </>
  );
}

/** "Claude · 200,000 tokens · USD 3 / 15 per million". */
export function modelLabel(model: ModelInfo): string {
  const context = model.contextWindow;
  if (!model.pricing) return t("agent.model.option", { name: model.displayName, context });
  const price = (value: number) => (Math.round(value * 100) / 100).toString();
  return t("agent.model.optionPriced", {
    name: model.displayName,
    context,
    input: price(model.pricing.inputPerMTok),
    output: price(model.pricing.outputPerMTok),
  });
}

/**
 * The default model (FR-022): context window, price and capabilities shown; models that
 * cannot use tools are listed apart, as they work only in Ask mode.
 */
export function ModelPicker() {
  const { bridge, agent } = useWorkbench();
  const models = useAgent((state) => state.models);
  const error = useAgent((state) => state.modelsError);
  const [current, setCurrent] = useState<string | null>(null);
  const selectId = useId();

  useEffect(() => {
    void agent.getState().loadModels();
    void bridge.settings
      .get()
      .then((settings) => setCurrent(settings.providers.openrouter.defaultModel));
  }, [agent, bridge]);

  const choose = async (modelId: string) => {
    setCurrent(modelId);
    await agent.getState().setModel(modelId);
  };

  const withTools = (models ?? []).filter((model) => model.capabilities.tools);
  const without = (models ?? []).filter((model) => !model.capabilities.tools);
  const sorted = (list: ModelInfo[]) =>
    [...list].sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={selectId} className="font-medium">
        {t("settings.providers.model")}
      </label>
      <div className="flex items-center gap-2">
        <select
          id={selectId}
          value={current ?? ""}
          disabled={!models}
          onChange={(event) => void choose(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 py-1.5"
        >
          <option value="" disabled>
            {models ? t("agent.model.choose") : t("agent.model.loading")}
          </option>
          {current && models && !models.some((model) => model.id === current) && (
            <option value={current}>{current}</option>
          )}
          {sorted(withTools).map((model) => (
            <option key={model.id} value={model.id}>
              {modelLabel(model)}
            </option>
          ))}
          {without.length > 0 && (
            <optgroup label={t("agent.mode.askHint")}>
              {sorted(without).map((model) => (
                <option key={model.id} value={model.id}>
                  {modelLabel(model)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <Button onClick={() => void agent.getState().loadModels(true)}>
          {t("settings.providers.refresh")}
        </Button>
      </div>
      <p className="m-0 text-text-muted">{t("settings.providers.modelHint")}</p>
      {error && (
        <p role="alert" className="m-0 text-danger">
          {t("agent.model.failed", { reason: error })}
        </p>
      )}
    </div>
  );
}
