import type { ThemeTokens } from "@jesutobits/extension-schema";
import { useId } from "react";
import { t } from "../../i18n";
import { useAppearance, useWorkbench } from "../../state/workbench-context";
import { baseTheme, BUILTIN_THEMES } from "./builtin-themes";

const FOLLOW = "follow-os";

/**
 * Theme choice (UX_AND_INTERFACE.md sections 3 and 8): Follow system or a built-in theme,
 * each with a small preview drawn from its own tokens. Choosing applies it at once.
 */
export function ThemePicker() {
  const { bridge } = useWorkbench();
  const appearance = useAppearance((state) => state.appearance);
  const name = useId();
  const current = appearance?.followOsTheme ? FOLLOW : appearance?.theme;

  const choose = (value: string) =>
    void bridge.settings
      .update({
        appearance:
          value === FOLLOW ? { followOsTheme: true } : { followOsTheme: false, theme: value },
      })
      .catch((error: unknown) => bridge.log("error", `theme change failed: ${String(error)}`));

  const options = [
    { id: FOLLOW, label: t("appearance.followOs"), preview: <FollowPreview /> },
    ...BUILTIN_THEMES.map((theme) => ({
      id: theme.id,
      label: theme.label,
      preview: <Preview tokens={theme.tokens} />,
    })),
  ];

  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-2 p-0 font-medium">{t("appearance.theme")}</legend>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
        {options.map((option) => (
          <label
            key={option.id}
            className={`flex cursor-pointer flex-col gap-2 rounded-md border p-2 hover:bg-item-hover ${
              current === option.id ? "border-accent" : "border-border"
            }`}
          >
            {option.preview}
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={current === option.id}
                onChange={() => choose(option.id)}
              />
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A miniature Workbench in a theme's colours. Decorative: the label says which theme. */
function Preview({ tokens }: { tokens: ThemeTokens }) {
  const full = { ...baseTheme(tokens.base).tokens, ...tokens };
  return (
    <div
      aria-hidden="true"
      className="flex h-14 overflow-hidden rounded-sm border border-border"
      style={{ background: full["color.canvas"] }}
    >
      <div className="w-1/4" style={{ background: full["color.surface"] }} />
      <div className="flex flex-1 flex-col gap-1 p-1.5">
        <div className="h-1.5 w-3/4 rounded-sm" style={{ background: full["color.text"] }} />
        <div className="h-1.5 w-1/2 rounded-sm" style={{ background: full["color.text.muted"] }} />
        <div
          className="mt-auto h-2 w-1/3 rounded-sm"
          style={{ background: full["color.accent"] }}
        />
      </div>
    </div>
  );
}

function FollowPreview() {
  return (
    <div aria-hidden="true" className="flex h-14 overflow-hidden rounded-sm border border-border">
      <div className="flex-1">
        <Preview tokens={baseTheme("light").tokens} />
      </div>
      <div className="flex-1">
        <Preview tokens={baseTheme("dark").tokens} />
      </div>
    </div>
  );
}
