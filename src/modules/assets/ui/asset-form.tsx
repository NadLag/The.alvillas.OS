"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { normalizeAmountInput } from "@/platform/money/amount-input";
import type { AppLocale } from "@/i18n/routing";
import { assetConditions, createAssetSchema, reviseAssetSchema, type AssetFields } from "../domain/asset";
import { saveAssetAction } from "../application/asset-actions";

type Edit = { id: string; number: number; fields: AssetFields; canEditCost: boolean };
type Property = { id: string; label: string; canEnterCost: boolean };
type Props = { locale: AppLocale } & ({ asset: Edit; properties?: never } | { asset?: never; properties: Property[] });

export function AssetForm({ locale, asset, properties }: Props) {
  const t = useTranslations("Assets");
  const router = useRouter();
  const [propertyId, setPropertyId] = useState("");
  const [status, setStatus] = useState<"ready" | "saving" | "invalid" | "forbidden" | "conflict" | "offline" | "unavailable">("ready");
  const pending = useRef<{ signature: string; nonce: string } | null>(null);
  const fields = asset?.fields;
  const canEnterCost = asset?.canEditCost ?? Boolean(properties?.find(property => property.id === propertyId)?.canEnterCost);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!navigator.onLine) { setStatus("offline"); return; }
    const form = new FormData(event.currentTarget);
    const text = (field: string) => { const value = form.get(field); return typeof value === "string" ? value : ""; };
    const nullable = (field: string) => text(field).trim() || null;
    const amount = normalizeAmountInput(text("amount").trim());
    const currency = text("currency").trim().toUpperCase();
    const draft = {
      name: text("name"), category: text("category"), description: text("description"), condition: text("condition"),
      purchaseOn: nullable("purchaseOn"), warrantyProvider: nullable("warrantyProvider"), warrantyReference: nullable("warrantyReference"),
      warrantyStartsOn: nullable("warrantyStartsOn"), warrantyEndsOn: nullable("warrantyEndsOn"),
      usefulLifeMonths: nullable("usefulLifeMonths") ? Number(text("usefulLifeMonths")) : null,
      ...(canEnterCost ? { cost: amount || currency ? { amount, currency } : null } : {})
    };
    const command = { fields: draft, reason: text("reason"), ...(asset
      ? { assetId: asset.id, expectedRevision: asset.number } : { propertyId, tag: text("tag") }) };
    const signature = JSON.stringify(command);
    if (pending.current?.signature !== signature) pending.current = { signature, nonce: crypto.randomUUID() };
    const input = { ...command, idempotencyKey: pending.current.nonce };
    const parsed = (asset ? reviseAssetSchema : createAssetSchema).safeParse(input);
    if (!parsed.success) { setStatus("invalid"); return; }
    setStatus("saving");
    try {
      const result = await saveAssetAction(parsed.data);
      if (!result.ok) { setStatus(result.code); return; }
      pending.current = null;
      setStatus("ready");
      router.push("/" + locale + "/app/assets/" + result.asset.id);
      router.refresh();
    } catch { setStatus("unavailable"); }
  }

  return <form className="resource-form" onSubmit={event => void submit(event)} data-testid="asset-form">
    <fieldset className="resource-form maintenance-work-order-editor" disabled={status === "saving"}>
      <legend>{t(asset ? "edit" : "create")}</legend>
      {!asset ? <>
        <label className="field"><span>{t("property")}</span><select name="propertyId" value={propertyId} onChange={event => setPropertyId(event.target.value)} required>
          <option value="">{t("chooseProperty")}</option>
          {properties?.map(property => <option key={property.id} value={property.id}>{property.label}</option>)}
        </select></label>
        <label className="field"><span>{t("tag")}</span><input name="tag" dir="ltr" maxLength={64} required /></label>
      </> : null}
      <label className="field"><span>{t("name")}</span><input name="name" dir="auto" defaultValue={fields?.name} maxLength={160} required /></label>
      <label className="field"><span>{t("category")}</span><input name="category" dir="auto" defaultValue={fields?.category} maxLength={120} required /></label>
      <label className="field"><span>{t("description")}</span><textarea name="description" dir="auto" defaultValue={fields?.description} maxLength={2000} /></label>
      <label className="field"><span>{t("condition")}</span><select name="condition" defaultValue={fields?.condition ?? ""} required>
        <option value="">{t("chooseCondition")}</option>
        {assetConditions.map(condition => <option key={condition} value={condition}>{t("conditions." + condition)}</option>)}
      </select></label>
      <label className="field"><span>{t("purchaseOn")}</span><input name="purchaseOn" type="date" defaultValue={fields?.purchaseOn ?? undefined} /></label>
      {canEnterCost ? <>
        <label className="field"><span>{t("cost")}</span><input name="amount" dir="ltr" inputMode="decimal" defaultValue={fields?.cost?.amount} maxLength={19} /></label>
        <label className="field"><span>{t("currency")}</span><input name="currency" dir="ltr" autoCapitalize="characters" defaultValue={fields?.cost?.currency} maxLength={3} /></label>
      </> : null}
      <label className="field"><span>{t("warrantyProvider")}</span><input name="warrantyProvider" dir="auto" defaultValue={fields?.warrantyProvider ?? undefined} maxLength={160} /></label>
      <label className="field"><span>{t("warrantyReference")}</span><input name="warrantyReference" dir="auto" defaultValue={fields?.warrantyReference ?? undefined} maxLength={120} /></label>
      <label className="field"><span>{t("warrantyStartsOn")}</span><input name="warrantyStartsOn" type="date" defaultValue={fields?.warrantyStartsOn ?? undefined} /></label>
      <label className="field"><span>{t("warrantyEndsOn")}</span><input name="warrantyEndsOn" type="date" defaultValue={fields?.warrantyEndsOn ?? undefined} /></label>
      <label className="field"><span>{t("life")}</span><input name="usefulLifeMonths" type="number" min={1} max={2147483647} defaultValue={fields?.usefulLifeMonths ?? undefined} /></label>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" minLength={6} maxLength={1000} required /></label>
      <button type="submit" className="primary-button">{t(status === "saving" ? "saving" : "save")}</button>
    </fieldset>
    {status !== "ready" && status !== "saving" ? <p role="alert">{t("errors." + status)}</p> : null}
  </form>;
}
