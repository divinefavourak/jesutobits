import { t } from "../../i18n";
import { useProjects, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ProjectError } from "./ProjectError";

/**
 * Asked once for a folder Jesutobits did not create (FR-006, SECURITY.md section 5.4). Focus
 * starts on the dialog, not on Trust, so Enter cannot trust a folder by accident. Restricted
 * mode is enforced when tools arrive (Phase 3); the decision is stored now.
 */
export function TrustDialog() {
  const { projects } = useWorkbench();
  const open = useProjects((state) => state.needsTrustDecision);
  const name = useProjects((state) => state.active?.name ?? "");
  const busy = useProjects((state) => state.busy);
  const decide = (trust: "trusted" | "restricted") => void projects.getState().setTrust(trust);

  return (
    <Dialog
      open={open}
      title={t("trust.title")}
      focusSelf
      onCancel={() => projects.getState().deferTrust()}
      description={
        <>
          <p className="m-0 text-text">{t("trust.body", { name })}</p>
          <p className="m-0">{t("trust.safe")}</p>
          <p className="m-0">{t("trust.restricted")}</p>
        </>
      }
    >
      <ProjectError only={["trust"]} />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => projects.getState().deferTrust()}>
          {t("trust.later")}
        </Button>
        <Button disabled={busy} onClick={() => decide("restricted")}>
          {t("trust.restrict")}
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => decide("trusted")}>
          {t("trust.trust")}
        </Button>
      </div>
    </Dialog>
  );
}
