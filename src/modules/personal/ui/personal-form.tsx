"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { mutatePersonal } from "../application/personal-actions";

export function PersonalForm({
  target, children, submitLabel
}: {
  target: Parameters<typeof mutatePersonal>[0]; children: ReactNode; submitLabel?: string;
}) {
  const t = useTranslations("Personal");
  const [state, action, pending] = useActionState(mutatePersonal.bind(null, target), { status: "idle" as const });
  return (
    <form action={action} className="form-grid">
      {children}
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={pending}>{pending ? t("saving") : submitLabel ?? t("save")}</button>
        {state.status === "saved" ? <p role="status">{t("saved")}</p> : null}
        {state.status !== "idle" && state.status !== "saved" ? <p role="alert">{t(state.status)}</p> : null}
      </div>
    </form>
  );
}
