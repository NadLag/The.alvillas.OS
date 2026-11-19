"use client";

import { useState, type FormEvent } from "react";
import type { getWebsiteAssessmentForm } from "@/modules/crm/application/lead-capture-service";
import type { LeadCaptureInput } from "@/modules/crm/domain/lead-capture";
import { websiteAssessmentFields } from "@/modules/crm/domain/lead-field-limits";
import styles from "../website.module.css";

type FormConfig = NonNullable<Awaited<ReturnType<typeof getWebsiteAssessmentForm>>>;
type Choice = FormConfig["sources"][number];
type Status = "idle" | "sending" | "accepted" | "validation" | "rateLimited" | "failed" | "changed";

function textValue(data: FormData, key: string) {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function AssessmentForm({ form, labels }: { form: FormConfig; labels: Record<string, string> }) {
  const [status, setStatus] = useState<Status>("idle");
  const busy = status === "sending";
  const emailRequired = form.contactRequirement === "EMAIL" || form.contactRequirement === "PHONE_AND_EMAIL";
  const phoneRequired = form.contactRequirement === "PHONE" || form.contactRequirement === "PHONE_AND_EMAIL";
  const contactEither = form.contactRequirement === "PHONE_OR_EMAIL";
  const required = (field: FormConfig["requiredFields"][number]) => form.requiredFields.includes(field);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || status === "accepted" || status === "changed") return;
    const data = new FormData(event.currentTarget);
    const bedrooms = textValue(data, "bedrooms");
    const currentOtaKeys = data.getAll("currentOtaKeys").map(String);
    const fields: LeadCaptureInput["fields"] = {
      ownerContact: textValue(data, "ownerContact"),
      phone: textValue(data, "phone"),
      email: textValue(data, "email"),
      location: textValue(data, "location"),
      propertyTypeKey: textValue(data, "propertyTypeKey"),
      bedrooms: bedrooms === undefined ? undefined : Number(bedrooms),
      currentRentalStatusKey: textValue(data, "currentRentalStatusKey"),
      currentOtaKeys: currentOtaKeys.length ? currentOtaKeys : undefined,
      objectives: textValue(data, "objectives"),
      notes: textValue(data, "notes"),
    };
    const sourceKey = form.sources.length === 1 ? form.sources[0].key : textValue(data, "sourceKey");
    if ((contactEither && !fields.phone && !fields.email) || (required("currentOtaKeys") && !currentOtaKeys.length) ||
      !sourceKey || data.get("acknowledge") !== "on") {
      setStatus("validation");
      return;
    }
    setStatus("sending");
    try {
      const response = await fetch("/api/public/assessment-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "WEBSITE", locale: form.locale, idempotencyKey: form.idempotencyKey, sourceKey, fields,
          websiteAcknowledgement: {
            approvalReference: form.approvalReference, noticeSha256: form.noticeSha256, affirmed: true
          },
          websiteForm: { issuedAt: form.issuedAt, signature: form.signature, website: data.get("website") }
        })
      });
      const result: unknown = response.status === 202 ? await response.json() : null;
      if (typeof result === "object" && result !== null && "accepted" in result && result.accepted === true) setStatus("accepted");
      else if (response.status === 400) setStatus("validation");
      else if (response.status === 409) setStatus("changed");
      else if (response.status === 429) setStatus("rateLimited");
      else setStatus("failed");
    } catch {
      setStatus("failed");
    }
  }

  function select(name: string, choices: Choice[], isRequired: boolean) {
    if (!choices.length) return null;
    return (
      <label className="field">
        <span>{labels[name]}</span>
        <select name={name === "source" ? "sourceKey" : name} required={isRequired} defaultValue="">
          <option value="">{labels.choice}</option>
          {choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
        </select>
      </label>
    );
  }

  if (status === "accepted") return <p className="form-status" role="status">{labels.accepted}</p>;

  return (
    <form className={`resource-form ${styles.assessmentForm}`} method="post" action="/api/public/assessment-requests" onSubmit={event => { void submit(event); }} aria-busy={busy}>
      <fieldset disabled={busy || status === "changed"} className={styles.assessmentFields}>
        <div className={styles.assessmentGrid}>
          <label className="field"><span>{labels.ownerContact}</span>
            <input name="ownerContact" autoComplete="name" required={required("ownerContact")} maxLength={websiteAssessmentFields.ownerContact} dir="auto" />
          </label>
          <label className="field"><span>{labels.location}</span>
            <input name="location" required={required("location")} maxLength={websiteAssessmentFields.location} dir="auto" />
          </label>
          <label className="field"><span>{labels.email}</span>
            <input name="email" type="email" autoComplete="email" required={emailRequired || required("email")}
              aria-describedby={contactEither ? "assessment-contact" : undefined} maxLength={websiteAssessmentFields.email} dir="ltr" />
          </label>
          <label className="field"><span>{labels.phone}</span>
            <input name="phone" type="tel" autoComplete="tel" required={phoneRequired || required("phone")}
              aria-describedby={contactEither ? "assessment-contact" : undefined} maxLength={websiteAssessmentFields.phone} dir="ltr" />
          </label>
          {contactEither && <p id="assessment-contact" className={styles.contactHint}>{labels.contactEither}</p>}
          {select("propertyTypeKey", form.propertyTypes, required("propertyTypeKey"))}
          <label className="field"><span>{labels.bedrooms}</span>
            <input name="bedrooms" type="number" inputMode="numeric" min={0} max={2147483647} step={1} required={required("bedrooms")} />
          </label>
          {select("currentRentalStatusKey", form.rentalStatuses, required("currentRentalStatusKey"))}
          {form.sources.length > 1 && select("source", form.sources, true)}
        </div>
        {form.otas.length > 0 && <fieldset className={styles.assessmentFields}>
          <legend>{labels.currentOtaKeys}</legend>
          <div className={styles.checkboxes}>{form.otas.map(choice => (
            <label key={choice.key}><input type="checkbox" name="currentOtaKeys" value={choice.key} />{choice.label}</label>
          ))}</div>
        </fieldset>}
        <label className="field"><span>{labels.objectives}</span>
          <textarea name="objectives" required={required("objectives")} maxLength={websiteAssessmentFields.objectives} dir="auto" />
        </label>
        <label className="field"><span>{labels.notes}</span>
          <textarea name="notes" required={required("notes")} maxLength={websiteAssessmentFields.notes} dir="auto" />
        </label>
        <input name="website" type="text" hidden autoComplete="off" tabIndex={-1} />
        <div className={styles.assessmentNotice}>
          <p>{form.notice}</p>
          <label><input name="acknowledge" type="checkbox" required />{labels.acknowledgement}</label>
        </div>
      </fieldset>
      {status !== "idle" && status !== "sending" && <p className="form-error" role="alert">{labels[status]}</p>}
      <div>
        {status === "changed" ? <a className="secondary-button" href={`/${form.locale}/assessment`}>{labels.reload}</a> :
          <button className="primary-button" disabled={busy} type="submit">{labels[busy ? "sending" : "submit"]}</button>}
      </div>
    </form>
  );
}
