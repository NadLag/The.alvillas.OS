"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { localizedText } from "@/i18n/content";
import type { AppLocale } from "@/i18n/routing";
import type { readAssetPreventiveSchedule } from "../application/preventive-schedule";
import { saveAssetPreventiveScheduleAction } from "../application/preventive-schedule-action";

type Schedule = NonNullable<Awaited<ReturnType<typeof readAssetPreventiveSchedule>>>;
const weekdays = [0, 1, 2, 3, 4, 5, 6];
const priorities = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

export function AssetPreventiveEditor({ assetId, locale, data }: { assetId: string; locale: AppLocale; data: Schedule }) {
  const t = useTranslations("Assets.schedule");
  const errors = useTranslations("Assets.errors");
  const operations = useTranslations("Operations.manage.priorities");
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "invalid" | "forbidden" | "conflict" | "unavailable">("idle");
  const [enabled, setEnabled] = useState(data.schedule?.enabled ?? true);
  const { schedule, checklists, version } = data;
  const minute = schedule?.start_minute;
  const initialTime = minute === undefined ? undefined : [Math.floor(minute / 60), minute % 60].map(value => String(value).padStart(2, "0")).join(":");
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    const form = new FormData(event.currentTarget);
    const string = (key: string) => { const value = form.get(key); return typeof value === "string" ? value : ""; };
    const [hours, minutes] = string("time").split(":").map(Number);
    try {
      const result = await saveAssetPreventiveScheduleAction({ assetId, expectedVersion: version, reason: string("reason"),
        cancelFuture: form.has("cancelFuture"), definition: {
          title: { en: string("en"), fr: string("fr"), ar: string("ar") },
          starts_on: string("start"), ends_on: string("end") || null, start_minute: hours * 60 + minutes,
          checklist_template_key: string("checklist"), every_days: Number(string("interval")),
          weekdays: form.getAll("weekday").map(Number), priority: string("priority"), enabled
        } });
      setStatus(result);
      if (result === "saved") router.refresh();
    } catch { setStatus("unavailable"); }
  }

  if (!checklists.length) return <p>{t("noChecklists")}</p>;
  return <form onSubmit={event => void save(event)} className="resource-form">
    <fieldset className="resource-form" disabled={status === "saving"}>
      <legend>{t("edit")}</legend>
      <label className="field"><span>{t("nameEn")}</span><input name="en" maxLength={240} dir="auto" defaultValue={schedule?.title.en} required /></label>
      <label className="field"><span>{t("nameFr")}</span><input name="fr" maxLength={240} dir="auto" defaultValue={schedule?.title.fr} required /></label>
      <label className="field"><span>{t("nameAr")}</span><input name="ar" maxLength={240} dir="auto" defaultValue={schedule?.title.ar} /></label>
      <label className="field"><span>{t("start")}</span><input name="start" type="date" defaultValue={schedule?.starts_on} required /></label>
      <label className="field"><span>{t("end")}</span><input name="end" type="date" defaultValue={schedule?.ends_on ?? undefined} /></label>
      <label className="field"><span>{t("time")}</span><input name="time" type="time" defaultValue={initialTime} required /></label>
      <label className="field"><span>{t("interval")}</span><input name="interval" type="number" min={1} max={366} defaultValue={schedule?.every_days} required /></label>
      <fieldset className="resource-form"><legend>{t("weekdays")}</legend>{weekdays.map(day =>
        <label key={day}><input name="weekday" type="checkbox" value={day} defaultChecked={schedule?.weekdays.includes(day) ?? true}/>
          {weekday.format(new Date(Date.UTC(2024, 0, 7 + day)))}</label>
      )}</fieldset>
      <label className="field"><span>{t("checklist")}</span><select name="checklist" defaultValue={schedule?.checklist_template_key ?? ""} required>
        <option value="">{t("choose")}</option>
        {checklists.map(item => <option key={item.key} value={item.key}>{localizedText(item.name, locale)}</option>)}
      </select></label>
      <label className="field"><span>{t("priority")}</span><select name="priority" defaultValue={schedule?.priority ?? ""} required>
        <option value="">{t("choose")}</option>{priorities.map(priority => <option key={priority} value={priority}>{operations(priority)}</option>)}
      </select></label>
      <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> {t("enabled")}</label>
      {!enabled && schedule ? <label><input name="cancelFuture" type="checkbox" /> {t("cancelFuture")}</label> : null}
      <label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" minLength={6} maxLength={500} required /></label>
      <button className="primary-button" type="submit">{t(status === "saving" ? "saving" : "save")}</button>
    </fieldset>
    {status === "saved" ? <p role="status">{t("saved")}</p> : null}
    {status !== "saving" && status !== "idle" && status !== "saved" ? <p role="alert">{errors(status)}</p> : null}
  </form>;
}
