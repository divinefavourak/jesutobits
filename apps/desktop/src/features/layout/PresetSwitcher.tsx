import { useId } from "react";
import { t } from "../../i18n";
import { useLayout, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";
import { PRESET_IDS, type PresetId } from "./layout-model";

/**
 * Layout preset switcher in the title bar (UX_AND_INTERFACE.md section 4.3). A changed
 * layout shows as "Custom (based on Code)" and offers Reset.
 */
export function PresetSwitcher() {
  const { layout: store } = useWorkbench();
  const preset = useLayout((state) => state.layout?.preset);
  const modified = useLayout((state) => state.layout?.modified ?? false);
  const id = useId();
  if (!preset) return null;

  return (
    <div className="flex items-center gap-1">
      <label htmlFor={id} className="text-text-muted">
        {t("layout.preset")}
      </label>
      <select
        id={id}
        value={preset}
        onChange={(event) => store.getState().usePreset(event.target.value as PresetId)}
        className="rounded-md border border-border-strong bg-surface-raised px-1.5 py-0.5 text-text"
      >
        {PRESET_IDS.map((option) => (
          <option key={option} value={option}>
            {modified && option === preset
              ? t("layout.preset.custom", { preset: t(`layout.preset.${option}`) })
              : t(`layout.preset.${option}`)}
          </option>
        ))}
      </select>
      {modified && (
        <Button variant="ghost" onClick={() => store.getState().reset()}>
          {t("layout.reset")}
        </Button>
      )}
    </div>
  );
}
