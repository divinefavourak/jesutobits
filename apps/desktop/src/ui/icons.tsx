import type { ReactNode } from "react";

/** 16 px line icons drawn with the current text colour. Decorative: buttons carry the label. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const FilesIcon = () => (
  <Icon>
    <path d="M2.5 3.5h4l1.5 1.5h5.5v7.5h-11z" />
  </Icon>
);
export const EditorIcon = () => (
  <Icon>
    <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
  </Icon>
);
export const PreviewIcon = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M2 6h12" />
  </Icon>
);
export const AgentIcon = () => (
  <Icon>
    <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />
  </Icon>
);
export const InspectorIcon = () => (
  <Icon>
    <path d="M3 4h10M3 8h6M3 12h8" />
    <circle cx="12" cy="8" r="1.5" />
  </Icon>
);
export const TerminalIcon = () => (
  <Icon>
    <path d="m3.5 5 3 3-3 3M8 11.5h4.5" />
  </Icon>
);
export const ProblemsIcon = () => (
  <Icon>
    <path d="M8 2.5 14 13H2z" />
    <path d="M8 6.5v3M8 11.2v.1" />
  </Icon>
);
export const OutputIcon = () => (
  <Icon>
    <path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5" />
  </Icon>
);
export const MoreIcon = () => (
  <Icon>
    <path d="M4 8h.1M8 8h.1M12 8h.1" strokeWidth="2.2" />
  </Icon>
);
export const CollapseIcon = () => (
  <Icon>
    <path d="M4 8h8" />
  </Icon>
);
