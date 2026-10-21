import type { Project } from "@jesutobits/protocol";
import { t } from "../../i18n";
import { Badge, type BadgeTone } from "../../ui/Badge";

const TONE: Record<Project["trust"], BadgeTone> = {
  trusted: "success",
  restricted: "warning",
  unknown: "neutral",
};

/** One marker for trusted versus restricted, used everywhere (UX_AND_INTERFACE.md section 1). */
export function TrustBadge({ trust }: { trust: Project["trust"] }) {
  return <Badge tone={TONE[trust]}>{t(`project.trust.${trust}`)}</Badge>;
}
