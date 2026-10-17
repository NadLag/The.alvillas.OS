"use client";

import { useActionState, useState } from "react";
import { useTranslations, useFormatter } from "next-intl";
import type { PropertyTemplateVersion } from "@prisma/client";
import { templateAction, type TemplateActionState } from "../application/property-template-actions";
import { type propertyTemplateState } from "../application/property-template-service";
import {
  templateChangeSchema,
  templateSaveSchema,
  pathSegments,
  flattenSettings,
  equalSetting,
  settingInputText,
  type TemplateValues,
  type TemplateKind
} from "../domain/property-template";
import { TemplateValueEditor } from "./template-value-editor";
import { localizedText } from "@/i18n/content";
import { type AppLocale } from "@/i18n/routing";
import { formatNumber } from "@/i18n/format";

const initialState: TemplateActionState = { status: "idle", message: "generic" };
const asText = (value: unknown): Record<string, string> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
type Version = Omit<PropertyTemplateVersion, "createdAt"> & { createdAt: string };
type PropertyState = Awaited<ReturnType<typeof propertyTemplateState>>;
export function TemplateEditor({
  locale,
  kind,
  selected,
  latestVersion,
  properties,
  targetId
}: {
  locale: AppLocale;
  kind: TemplateKind;
  selected?: Version;
  latestVersion: number;
  properties: Array<{ id: string; name: string }>;
  targetId: string;
}) {
  const t = useTranslations("Templates");
  const [values, setValues] = useState<TemplateValues>((selected?.values ?? {}) as TemplateValues);
  const [name, setName] = useState(asText(selected?.name));
  const [description, setDescription] = useState(asText(selected?.description));
  const [scope, setScope] = useState(selected?.propertyId ?? "");
  const [key, setKey] = useState(selected?.key ?? "");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"ACTIVE" | "ARCHIVED">(
    selected?.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE"
  );
  const [state, action, pending] = useActionState(
    templateAction.bind(null, locale, "save"),
    initialState
  );
  const [invalid, setInvalid] = useState(false);
  const payload = {
    key,
    kind,
    propertyId: scope || null,
    name,
    description: Object.values(description).some(Boolean) ? description : undefined,
    values,
    status,
    expectedVersion: latestVersion,
    reason
  };
  return (
    <section className="workspace-main template-editor" data-testid="template-editor">
      <h2>{selected ? t("revise") : t("create")}</h2>
      <p>{t("versionNote")}</p>
      <form
        action={action}
        onSubmit={(e) => {
          setInvalid(false);
          if (!templateSaveSchema.safeParse(payload).success) {
            e.preventDefault();
            setInvalid(true);
          }
        }}
        aria-busy={pending}
      >
        <input type="hidden" name="payload" value={JSON.stringify(payload)} />
        <fieldset disabled={pending || (state.status === "success" && !selected)}>
          <div className="template-fields">
            <label className="field">
              <span>{t("reference")}</span>
              <input
                required
                pattern="[a-z0-9][a-z0-9_.-]*"
                maxLength={100}
                readOnly={Boolean(selected)}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                data-testid="template-key"
              />
            </label>
            <label className="field">
              <span>{t("scope")}</span>
              <select
                value={scope}
                disabled={Boolean(selected)}
                onChange={(e) => setScope(e.target.value)}
                data-testid="template-scope"
              >
                <option value="">{t("organizationScope")}</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("status")}</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as "ACTIVE" | "ARCHIVED")}
                data-testid="template-status"
              >
                <option value="ACTIVE">{t("statuses.ACTIVE")}</option>
                <option value="ARCHIVED">{t("statuses.ARCHIVED")}</option>
              </select>
            </label>
          </div>
          <div className="template-bilingual">
            {(["en", "fr", "ar"] as const).map((language) => (
              <label className="field" key={language}>
                <span>
                  {t("name")} · {t(`languages.${language}`)}
                </span>
                <input
                  required={language !== "ar"}
                  maxLength={240}
                  lang={language}
                  dir={language === "ar" ? "rtl" : "ltr"}
                  value={name[language] ?? ""}
                  onChange={(e) =>
                    setName({ ...name, [language]: e.target.value || undefined } as Record<
                      string,
                      string
                    >)
                  }
                  data-testid={`template-name-${language}`}
                />
              </label>
            ))}
          </div>
          <details>
            <summary>{t("description")}</summary>
            <div className="template-bilingual">
              {(["en", "fr", "ar"] as const).map((language) => (
                <label className="field" key={language}>
                  <span>
                    {t("description")} · {t(`languages.${language}`)}
                  </span>
                  <textarea
                    maxLength={240}
                    value={description[language] ?? ""}
                    lang={language}
                    dir={language === "ar" ? "rtl" : "ltr"}
                    onChange={(e) =>
                      setDescription({
                        ...description,
                        [language]: e.target.value || undefined
                      } as Record<string, string>)
                    }
                  />
                </label>
              ))}
            </div>
          </details>
          <TemplateValueEditor kind={kind} values={values} onChange={setValues} />
          <label className="field">
            <span>{t("reason")}</span>
            <textarea
              minLength={6}
              maxLength={500}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="template-reason"
            />
          </label>
          <div className="template-actions">
            <button className="primary-button" disabled={pending} data-testid="template-save">
              {pending ? t("saving") : selected ? t("saveVersion") : t("create")}
            </button>
          </div>
        </fieldset>
        <p
          role={invalid || state.status === "error" ? "alert" : "status"}
          data-testid="template-message"
        >
          {invalid
            ? t("messages.validation")
            : state.status !== "idle"
              ? t(`messages.${state.message}`)
              : null}
        </p>
        {state.status === "success" && !selected && state.id ? (
          <a
            className="secondary-button"
            href={`/${locale}/app/templates?kind=${kind}&template=${state.id}${targetId ? `&property=${targetId}` : ""}`}
          >
            {t("openSaved")}
          </a>
        ) : null}
      </form>
    </section>
  );
}
function FieldValue({
  value,
  label,
  change
}: {
  value: unknown;
  label: string;
  change: (v: unknown) => void;
}) {
  const t = useTranslations("Templates");
  if (typeof value === "boolean")
    return (
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => change(e.target.value === "true")}
      >
        <option value="true">{t("yes")}</option>
        <option value="false">{t("no")}</option>
      </select>
    );
  if (value && typeof value === "object" && !Array.isArray(value))
    return (
      <div className="template-bilingual">
        {(["en", "fr", "ar"] as const).map((language) => (
          <label className="field" key={language}>
            <span>{t(`languages.${language}`)}</span>
            <input
              aria-label={`${label} · ${t(`languages.${language}`)}`}
              lang={language}
              dir={language === "ar" ? "rtl" : "ltr"}
              value={asText(value)[language] ?? ""}
              onChange={(e) => change({ ...asText(value), [language]: e.target.value || undefined })}
            />
          </label>
        ))}
      </div>
    );
  return (
    <input
      aria-label={label}
      type={typeof value === "number" ? "number" : "text"}
      min={typeof value === "number" ? 0 : undefined}
      value={Array.isArray(value) ? value.map(settingInputText).join(", ") : settingInputText(value)}
      onChange={(e) =>
        change(
          typeof value === "number"
            ? Number(e.target.value)
            : Array.isArray(value)
              ? e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean)
              : e.target.value
        )
      }
    />
  );
}
export function TemplateApplication({
  locale,
  propertyId,
  kind,
  state,
  selected
}: {
  locale: AppLocale;
  propertyId: string;
  kind: TemplateKind;
  state: PropertyState;
  selected?: Version;
}) {
  const t = useTranslations("Templates"),
    format = useFormatter();
  const [result, action, pending] = useActionState(
    templateAction.bind(null, locale, "change"),
    initialState
  );
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [paths, setPaths] = useState<string[]>([]),
    [edits, setEdits] = useState<Record<string, unknown>>({}),
    [reason, setReason] = useState("");
  const [mode, setMode] = useState<"APPLY" | "OVERRIDE" | "RESET">("APPLY"),
    [invalid, setInvalid] = useState(false);
  const payload = {
    action: mode,
    propertyId,
    kind,
    templateVersionId: selected?.id,
    expectedRevision: state.binding?.revision ?? 0,
    operationId,
    reason,
    paths,
    values: Object.fromEntries(
      paths.map((path) => [
        path,
        Object.hasOwn(edits, path) ? edits[path] : state.fields.find((f) => f.path === path)?.current
      ])
    )
  };
  const valueLabel = (v: unknown, path = ""): string => {
    if (path.endsWith("/amount") && typeof v === "string") {
      try {
        return formatNumber(locale, v, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      } catch {
        return v;
      }
    }
    const leaf = pathSegments(path || "/setting").at(-1)!;
    const group = leaf.endsWith("Frequency")
      ? "cadences"
      : (
          {
            type: "taskTypes",
            due: "anchors",
            priority: "priorities",
            category: "categories",
            pricing_model: "pricingModels"
          } as Record<string, string>
        )[leaf];
    if (group && typeof v === "string") return t(`${group}.${v}`);
    return typeof v === "boolean"
      ? t(v ? "yes" : "no")
      : typeof v === "number"
        ? format.number(v)
        : Array.isArray(v)
          ? v.join(", ")
          : v && typeof v === "object"
            ? localizedText(asText(v), locale)
            : v == null
              ? t("unset")
              : settingInputText(v);
  };
  const fieldLabel = (path: string) => {
    const segments = pathSegments(path),
      leaf = segments.at(-1)!;
    if (segments[0] === "property" || segments[0] === "operating") return t(`fields.${leaf}`);
    const identity = [...segments]
      .reverse()
      .find((s) => s.startsWith("@"))
      ?.split(":")
      .slice(1)
      .join(":");
    const key =
      {
        quantity: "quantity",
        name: "name",
        description: "description",
        label: "instruction",
        amount: "amount",
        currency: "currency",
        pricing_model: "pricingModel",
        available: "available",
        nights: "nights",
        unit: "unit",
        category: "category",
        expected_per_stay: "expectedPerStay",
        title: "name",
        type: "taskType",
        due: "due",
        priority: "priority",
        checklistTemplateKey: "checklistReference",
        checklist: "inlineChecklist"
      }[leaf] ?? "setting";
    return `${identity ? `${identity} · ` : ""}${t(key)}`;
  };
  return (
    <section className="workspace-main template-application" data-testid="template-application">
      <h2>{t("inheritance")}</h2>
      <p>{t("resetNote")}</p>
      {state.binding ? (
        <p data-testid="template-pinned">
          {t("pinned", {
            name: localizedText(asText(state.binding.templateVersion.name), locale),
            version: state.binding.templateVersion.version,
            revision: state.binding.revision
          })}
        </p>
      ) : (
        <p>{t("notApplied")}</p>
      )}
      {state.latest && state.binding && state.latest.version > state.binding.templateVersion.version ? (
        <p className="notice" data-testid="template-update-available">
          {t("updateAvailable", { version: state.latest.version })}
        </p>
      ) : null}
      {selected && state.binding && selected.id !== state.binding.templateVersionId ? (
        <details open className="template-version-diff" data-testid="template-version-diff">
          <summary>{t("versionChanges")}</summary>
          <p>{t("upgradeNote")}</p>
          <dl>
            {Object.entries(flattenSettings(selected.values))
              .filter(
                ([path, value]) =>
                  !equalSetting(state.fields.find((field) => field.path === path)?.inherited, value)
              )
              .map(([path, value]) => (
                <div key={path}>
                  <dt>{fieldLabel(path)}</dt>
                  <dd>
                    {t("templateValue")}:{" "}
                    {valueLabel(state.fields.find((field) => field.path === path)?.inherited, path)} ·{" "}
                    {t("selectedVersionValue")}: {valueLabel(value, path)}
                  </dd>
                </div>
              ))}
          </dl>
        </details>
      ) : null}
      <form
        action={action}
        aria-busy={pending}
        onSubmit={(e) => {
          setInvalid(false);
          if (!templateChangeSchema.safeParse(payload).success) {
            e.preventDefault();
            setInvalid(true);
          }
        }}
      >
        <input type="hidden" name="payload" value={JSON.stringify(payload)} />
        <fieldset disabled={pending}>
          <div className="template-diff">
            {state.fields.map((field) => (
              <div
                className="template-diff-row"
                key={field.path}
                data-testid="template-diff-row"
                data-path={field.path}
              >
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={paths.includes(field.path)}
                    onChange={(e) => {
                      setOperationId(crypto.randomUUID());
                      setPaths(
                        e.target.checked ? [...paths, field.path] : paths.filter((p) => p !== field.path)
                      );
                    }}
                  />
                  <span>{fieldLabel(field.path)}</span>
                </label>
                <span className="status-badge">{t(field.overridden ? "overridden" : "inherited")}</span>
                <dl>
                  <div>
                    <dt>{t("templateValue")}</dt>
                    <dd>{valueLabel(field.inherited, field.path)}</dd>
                  </div>
                  <div>
                    <dt>{t("propertyValue")}</dt>
                    <dd>{valueLabel(field.current, field.path)}</dd>
                  </div>
                </dl>
                <FieldValue
                  label={t("overrideValue", { field: fieldLabel(field.path) })}
                  value={Object.hasOwn(edits, field.path) ? edits[field.path] : field.current}
                  change={(v) => {
                    setOperationId(crypto.randomUUID());
                    setEdits({ ...edits, [field.path]: v });
                    if (!paths.includes(field.path)) setPaths([...paths, field.path]);
                  }}
                />
              </div>
            ))}
          </div>
          <label className="field">
            <span>{t("reason")}</span>
            <textarea
              required
              minLength={6}
              maxLength={500}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setOperationId(crypto.randomUUID());
              }}
              data-testid="template-change-reason"
            />
          </label>
          <div className="template-actions">
            {selected && selected.status === "ACTIVE" ? (
              <button
                className="primary-button"
                type="submit"
                data-testid="template-apply"
                onClick={() => setMode("APPLY")}
              >
                {t("applyVersion", { version: selected.version })}
              </button>
            ) : null}
            {state.binding ? (
              <>
                <button
                  className="secondary-button"
                  type="submit"
                  data-testid="template-override"
                  disabled={!paths.length}
                  onClick={() => setMode("OVERRIDE")}
                >
                  {t("saveOverrides")}
                </button>
                <button
                  className="secondary-button"
                  type="submit"
                  data-testid="template-reset"
                  disabled={!paths.length}
                  onClick={() => setMode("RESET")}
                >
                  {t("resetSelected")}
                </button>
              </>
            ) : null}
          </div>
        </fieldset>
        <p
          role={invalid || result.status === "error" ? "alert" : "status"}
          data-testid="template-change-message"
        >
          {pending
            ? t("saving")
            : invalid
              ? t("messages.validation")
              : result.status !== "idle"
                ? t(`messages.${result.message}`)
                : null}
        </p>
      </form>
      <h3>{t("applicationHistory")}</h3>
      <p>{t("historyNote")}</p>
      <ol className="template-history">
        {state.history.map((row) => (
          <li key={row.id} data-testid="template-history-row">
            <strong>
              {t(`actions.${row.action}`)} · {t("version", { version: row.templateVersion.version })}
            </strong>
            <time dateTime={new Date(row.createdAt).toISOString()}>
              {format.dateTime(new Date(row.createdAt), { dateStyle: "medium", timeStyle: "short" })}
            </time>
            <p>{row.reason}</p>
            <details>
              <summary>{t("historicalValues")}</summary>
              <dl>
                {Object.entries(flattenSettings(row.snapshot)).map(([path, value]) => (
                  <div key={path}>
                    <dt>{fieldLabel(path)}</dt>
                    <dd>{valueLabel(value, path)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
