"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createSupplierInput, updateSupplierInput, archiveSupplierInput } from "../domain/supplier";
import { createSupplierAction, updateSupplierAction, setSupplierArchivedAction } from "../application/supplier-actions";
import type { getSupplier } from "../application/supplier-service";
type Supplier = Awaited<ReturnType<typeof getSupplier>>;
type ErrorCode = "forbidden" | "conflict" | "validation" | "error";

export function SupplierForm({ locale, supplier }: { locale: string; supplier?: Supplier }) {
  const t = useTranslations("Suppliers"), router = useRouter(), [pending, startTransition] = useTransition(), [error, setError] = useState<ErrorCode | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return <form className="resource-form" data-testid="supplier-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault(); if (pending) return;
    const values = Object.fromEntries(new FormData(event.currentTarget)), parsed = supplier ? updateSupplierInput.safeParse({ ...values, id: supplier.id, expectedVersion: supplier.version }) : createSupplierInput.safeParse({ ...values, idempotencyKey });
    if (!parsed.success) { setError("validation"); return; } setError(null);
    startTransition(async () => {
      try {
        const result = supplier ? await updateSupplierAction(parsed.data) : await createSupplierAction(parsed.data);
        if (!result.ok) setError(result.code); else { router.push(`/${locale}/app/finance/suppliers/${result.data.id}`); router.refresh(); }
      } catch { setError("error"); }
    });
  }}>
    {error ? <div role="alert"><p data-testid="supplier-error">{t(error)}</p>{error === "conflict" ? <button type="button" className="secondary-button" onClick={() => router.refresh()}>{t("reload")}</button> : null}</div> : null}
    <fieldset disabled={pending}><legend>{t(supplier ? "edit" : "create")}</legend><div className="form-grid">
      <label className="field"><span>{t("displayName")}</span><input name="displayName" data-testid="supplier-name" maxLength={200} defaultValue={supplier?.displayName} required /></label>
      <label className="field"><span>{t("category")}</span><input name="category" data-testid="supplier-category" maxLength={80} defaultValue={supplier?.category} required /></label>
      <label className="field"><span>{t("contactName")}</span><input name="contactName" maxLength={200} defaultValue={supplier?.contactName ?? ""} /></label>
      <label className="field"><span>{t("email")}</span><input name="email" type="email" maxLength={254} defaultValue={supplier?.email ?? ""} /></label>
      <label className="field"><span>{t("phone")}</span><input name="phone" type="tel" maxLength={16} defaultValue={supplier?.phone ?? ""} aria-describedby="supplier-phone-hint" /><small id="supplier-phone-hint">{t("phoneHint")}</small></label>
      <label className="field"><span>{t("externalReference")}</span><input name="externalReference" maxLength={100} defaultValue={supplier?.externalReference ?? ""} /></label>
      <label className="field"><span>{t("address")}</span><textarea name="address" maxLength={1000} defaultValue={supplier?.address ?? ""} /></label>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="supplier-reason" minLength={6} maxLength={500} required /></label>
    </div><div className="form-actions"><button className="primary-button" data-testid="supplier-save" type="submit">{t(pending ? "saving" : "save")}</button></div></fieldset>
  </form>;
}
export function SupplierArchiveForm({ supplier }: { supplier: Supplier }) {
  const t = useTranslations("Suppliers"), router = useRouter(), [pending, startTransition] = useTransition(), [error, setError] = useState<ErrorCode | null>(null);
  return <form className="resource-form" data-testid="supplier-archive-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault(); if (pending) return;
    const parsed = archiveSupplierInput.safeParse({ id: supplier.id, expectedVersion: supplier.version, archived: !supplier.archived, reason: new FormData(event.currentTarget).get("reason") });
    if (!parsed.success) { setError("validation"); return; } setError(null);
    startTransition(async () => { try { const result = await setSupplierArchivedAction(parsed.data); if (!result.ok) setError(result.code); else router.refresh(); } catch { setError("error"); } });
  }}>
    {error ? <p role="alert" data-testid="supplier-error">{t(error)}</p> : null}
    <fieldset disabled={pending}><legend>{t(supplier.archived ? "restore" : "archive")}</legend><p>{t("archiveGuidance")}</p>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="supplier-archive-reason" minLength={6} maxLength={500} required /></label>
      <div className="form-actions"><button className="secondary-button" data-testid="supplier-archive" type="submit">{t(pending ? "saving" : supplier.archived ? "restore" : "archive")}</button></div>
    </fieldset>
  </form>;
}
