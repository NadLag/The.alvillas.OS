"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { normalizeAmountInput } from "@/platform/money/amount-input";
import { disposalMethods, type AssetLifecycleCommand } from "../domain/asset-lifecycle";
import { recordAssetLifecycleAction } from "../application/asset-lifecycle-action";

type Kind = AssetLifecycleCommand["kind"];
export function AssetLifecycleEditor({ assetId, version, choices, canBudget }: {
  assetId: string; version: number; choices: Kind[]; canBudget: boolean;
}) {
  const t = useTranslations("Assets.lifecycle"), errors = useTranslations("Assets.errors");
  const router = useRouter();
  const [kind, setKind] = useState<Kind>(choices[0]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "invalid" | "forbidden" | "conflict" | "unavailable">("idle");
  const recent = useRef<{ signature: string; nonce: string } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (field: string) => { const value = form.get(field); return typeof value === "string" ? value.trim() : ""; };
    const amount = normalizeAmountInput(text("amount")), currency = text("currency").toUpperCase();
    const common = { assetId, expectedVersion: version, reason: text("reason"), kind };
    const command = kind === "CANCEL" ? common : { ...common, effectiveOn: text("date"),
      ...(kind === "PLAN" ? { budget: amount || currency ? { amount, currency } : null } : {}),
      ...(kind === "REPLACE" ? { successorTag: text("successorTag") } : {}),
      ...(kind === "DISPOSE" ? { method: text("method"), reference: text("reference") || null } : {}) };
    const signature = JSON.stringify(command);
    if (recent.current?.signature !== signature) recent.current = { signature, nonce: crypto.randomUUID() };
    setStatus("saving");
    try {
      const result = await recordAssetLifecycleAction({ ...command, idempotencyKey: recent.current.nonce });
      setStatus(result);
      if (result === "saved") router.refresh();
    } catch { setStatus("unavailable"); }
  }

  return <form className="resource-form" onSubmit={event => void save(event)}>
    <fieldset className="resource-form" disabled={status === "saving"}>
      <legend>{t("record")}</legend>
      <label className="field"><span>{t("change")}</span><select value={kind} onChange={event => setKind(event.target.value as Kind)}>
        {choices.map(choice => <option key={choice} value={choice}>{t("commands." + choice)}</option>)}
      </select></label>
      {kind !== "CANCEL" ? <label className="field"><span>{t(kind === "PLAN" ? "plannedOn" : "effectiveOn")}</span>
        <input name="date" type="date" required /></label> : null}
      {kind === "PLAN" && canBudget ? <>
        <label className="field"><span>{t("budget")}</span><input name="amount" dir="ltr" inputMode="decimal" maxLength={19} /></label>
        <label className="field"><span>{t("currency")}</span><input name="currency" dir="ltr" autoCapitalize="characters" maxLength={3} /></label>
      </> : null}
      {kind === "REPLACE" ? <label className="field"><span>{t("replacementTag")}</span>
        <input name="successorTag" maxLength={64} dir="ltr" required /></label> : null}
      {kind === "DISPOSE" ? <>
        <label className="field"><span>{t("method")}</span><select name="method" required>
          <option value="">{t("chooseMethod")}</option>{disposalMethods.map(method => <option key={method} value={method}>{t("methods." + method)}</option>)}
        </select></label>
        <label className="field"><span>{t("reference")}</span><input name="reference" dir="auto" maxLength={160} /></label>
      </> : null}
      <label className="field"><span>{t("reason")}</span><textarea name="reason" minLength={6} maxLength={1000} dir="auto" required /></label>
      <button type="submit" className="primary-button">{t(status === "saving" ? "saving" : "save")}</button>
    </fieldset>
    {status === "saved" ? <p role="status">{t("saved")}</p> : null}
    {status !== "saving" && status !== "idle" && status !== "saved" ? <p role="alert">{errors(status)}</p> : null}
  </form>;
}
