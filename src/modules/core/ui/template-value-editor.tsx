"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  propertyTemplateFields,
  operatingTemplateFields,
  settingInputText,
  type TemplateValues,
  type TemplateKind
} from "../domain/property-template";
import { operatingCadenceSchema } from "../domain/owner-property";
import {
  taskTypeSchema,
  taskDueAnchorSchema,
  parseConfigRuleValue
} from "@/platform/config/rule-registry";

type Item = Record<string, unknown>;
type Props = { kind: TemplateKind; values: TemplateValues; onChange: (values: TemplateValues) => void };
const record = (v: unknown): Item =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Item) : {};
const list = (v: unknown): Item[] => (Array.isArray(v) ? (v as Item[]) : []);
function Bilingual({
  label,
  value,
  change,
  required = true
}: {
  label: string;
  value: unknown;
  change: (value: unknown) => void;
  required?: boolean;
}) {
  const t = useTranslations("Templates");
  const text = record(value);
  return (
    <div className="template-bilingual">
      {(["en", "fr", "ar"] as const).map((locale) => (
        <label className="field" key={locale}>
          <span>
            {label} · {t(`languages.${locale}`)}
          </span>
          <input
            lang={locale}
            dir={locale === "ar" ? "rtl" : "ltr"}
            required={required && locale !== "ar"}
            maxLength={240}
            value={settingInputText(text[locale])}
            onChange={(e) => change({ ...text, [locale]: e.target.value || undefined })}
          />
        </label>
      ))}
    </div>
  );
}
export function TemplateValueEditor({ kind, values, onChange }: Props) {
  const t = useTranslations("Templates");
  const [automationText, setAutomationText] = useState(() =>
    values.rules?.["ops.workflows"] ? JSON.stringify(values.rules["ops.workflows"], null, 2) : ""
  );
  const [automationInvalid, setAutomationInvalid] = useState(false);
  const setSection = (
    section: "property" | "operating",
    field: string,
    value: unknown,
    remove = false
  ) => {
    const next = { ...values, [section]: { ...values[section] } };
    if (remove) delete next[section]?.[field];
    else next[section]![field] = value;
    if (!Object.keys(next[section] ?? {}).length) delete next[section];
    onChange(next);
  };
  const setRule = (key: string, value: unknown) =>
    onChange({ ...values, rules: { ...values.rules, [key]: value } });
  const textField = (
    label: string,
    value: unknown,
    change: (v: unknown) => void,
    type = "text",
    required = true
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        min={type === "number" ? 0 : undefined}
        step={type === "number" ? 1 : undefined}
        required={required}
        maxLength={type === "number" ? undefined : 240}
        value={settingInputText(value)}
        onChange={(e) => change(type === "number" ? Number(e.target.value) : e.target.value)}
      />
    </label>
  );
  const selectField = (
    label: string,
    value: unknown,
    options: readonly string[],
    change: (v: unknown) => void,
    group: string
  ) => (
    <label className="field">
      <span>{label}</span>
      <select value={settingInputText(value ?? options[0])} onChange={(e) => change(e.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {t(`${group}.${option}`)}
          </option>
        ))}
      </select>
    </label>
  );
  const checklistItems = (items: Item[], change: (items: Item[]) => void) => (
    <div className="template-repeatable">
      {items.map((item, i) => (
        <fieldset key={i}>
          <legend>{t("checklistItem", { number: i + 1 })}</legend>
          {textField(t("reference"), item.key, (v) =>
            change(items.map((x, n) => (n === i ? { ...x, key: v } : x)))
          )}
          <Bilingual
            label={t("instruction")}
            value={item.label}
            change={(v) => change(items.map((x, n) => (n === i ? { ...x, label: v } : x)))}
          />
          <button
            type="button"
            className="quiet-button"
            onClick={() => change(items.filter((_, n) => n !== i))}
          >
            {t("remove")}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="secondary-button"
        onClick={() => change([...items, { key: "", label: { en: "", fr: "" } }])}
      >
        {t("addInstruction")}
      </button>
    </div>
  );
  if (kind === "PROPERTY")
    return (
      <>
        {(["property", "operating"] as const).map((section) => (
          <fieldset key={section}>
            <legend>{t(section)}</legend>
            <div className="template-fields">
              {(section === "property" ? propertyTemplateFields : operatingTemplateFields).map(
                (field) => {
                  const included = Object.hasOwn(values[section] ?? {}, field),
                    value = values[section]?.[field];
                  const boolean =
                    field.startsWith("has") ||
                    field.endsWith("Enabled") ||
                    field.endsWith("Available") ||
                    field.endsWith("Managed");
                  const number = [
                    "bedrooms",
                    "bathrooms",
                    "livingSpaces",
                    "parkingSpaces",
                    "maxGuests"
                  ].includes(field);
                  const cadence = field.endsWith("Frequency");
                  return (
                    <div className="template-field" key={field}>
                      <label className="checkbox-field">
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={(e) =>
                            setSection(
                              section,
                              field,
                              boolean
                                ? false
                                : number
                                  ? 0
                                  : cadence
                                    ? "NONE"
                                    : ["amenities", "otherServices"].includes(field)
                                      ? []
                                      : "",
                              !e.target.checked
                            )
                          }
                        />
                        <span>{t(`fields.${field}`)}</span>
                      </label>
                      {included ? (
                        boolean ? (
                          <label className="field">
                            <span className="sr-only">{t(`fields.${field}`)}</span>
                            <select
                              aria-label={t(`fields.${field}`)}
                              value={value ? "true" : "false"}
                              onChange={(e) => setSection(section, field, e.target.value === "true")}
                            >
                              <option value="true">{t("yes")}</option>
                              <option value="false">{t("no")}</option>
                            </select>
                          </label>
                        ) : cadence ? (
                          selectField(
                            t(`fields.${field}`),
                            value,
                            operatingCadenceSchema.options,
                            (v) => setSection(section, field, v),
                            "cadences"
                          )
                        ) : (
                          textField(
                            t(`fields.${field}`),
                            Array.isArray(value) ? value.join(", ") : value,
                            (v) =>
                              setSection(
                                section,
                                field,
                                ["amenities", "otherServices"].includes(field)
                                  ? String(v)
                                      .split(",")
                                      .map((x) => x.trim())
                                      .filter(Boolean)
                                  : v
                              ),
                            number ? "number" : "text"
                          )
                        )
                      ) : null}
                    </div>
                  );
                }
              )}
            </div>
          </fieldset>
        ))}
        <fieldset>
          <legend>{t("midStay")}</legend>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={Boolean(values.rules?.["ops.mid_stay_threshold"])}
              onChange={(e) => {
                if (e.target.checked) setRule("ops.mid_stay_threshold", { nights: "" });
                else {
                  const rules = { ...values.rules };
                  delete rules["ops.mid_stay_threshold"];
                  onChange({ ...values, rules: Object.keys(rules).length ? rules : undefined });
                }
              }}
            />
            {t("includeMidStay")}
          </label>
          {values.rules?.["ops.mid_stay_threshold"]
            ? textField(
                t("nights"),
                record(values.rules["ops.mid_stay_threshold"]).nights,
                (v) =>
                  setRule("ops.mid_stay_threshold", {
                    ...record(values.rules?.["ops.mid_stay_threshold"]),
                    nights: v
                  }),
                "number"
              )
            : null}
        </fieldset>
      </>
    );
  const ruleKey = {
    INVENTORY: "inventory.minimums",
    WORKFLOW: "ops.reservation_task_templates",
    CHECKLIST: "ops.checklists",
    SERVICE_CATALOG: "services.pricing"
  }[kind];
  const collectionKey = {
    INVENTORY: "minimums",
    WORKFLOW: "tasks",
    CHECKLIST: "checklists",
    SERVICE_CATALOG: "services"
  }[kind];
  const rows = list(record(values.rules?.[ruleKey])[collectionKey]);
  const change = (next: Item[]) =>
    setRule(ruleKey, { ...record(values.rules?.[ruleKey]), [collectionKey]: next });
  return (
    <div className="template-repeatable">
      {kind === "WORKFLOW" ? (
        <details>
          <summary>{t("automationRules")}</summary>
          <p>{t("automationHelp")}</p>
          <label className="field">
            <span>{t("automationDefinition")}</span>
            <textarea
              data-testid="template-automation"
              dir="ltr"
              spellCheck={false}
              rows={10}
              value={automationText}
              aria-invalid={automationInvalid}
              onChange={(e) => {
                const text = e.target.value;
                setAutomationText(text);
                setAutomationInvalid(false);
                if (!text.trim()) {
                  const rules = { ...values.rules };
                  delete rules["ops.workflows"];
                  onChange({ ...values, rules });
                  return;
                }
                try {
                  const parsed = parseConfigRuleValue("ops.workflows", JSON.parse(text) as unknown);
                  setRule("ops.workflows", parsed);
                } catch {
                  setAutomationInvalid(true);
                  setRule("ops.workflows", { invalidDefinition: text });
                }
              }}
            />
          </label>
          {automationInvalid ? <p role="alert">{t("automationInvalid")}</p> : null}
        </details>
      ) : null}
      {rows.map((item, i) => {
        const set = (key: string, value: unknown) =>
          change(rows.map((x, n) => (n === i ? { ...x, [key]: value } : x)));
        return (
          <fieldset key={i} data-testid="template-entry">
            <legend>{t(`entry.${kind}`, { number: i + 1 })}</legend>
            {textField(t("reference"), item[kind === "INVENTORY" ? "item" : "key"], (v) =>
              set(kind === "INVENTORY" ? "item" : "key", v)
            )}
            <Bilingual
              label={t("name")}
              value={item[kind === "WORKFLOW" ? "title" : "name"]}
              change={(v) => set(kind === "WORKFLOW" ? "title" : "name", v)}
            />
            {kind === "INVENTORY" ? (
              <div className="template-fields">
                {textField(t("quantity"), item.quantity, (v) => set("quantity", v), "number")}
                {textField(t("unit"), item.unit, (v) => set("unit", v))}
                {selectField(
                  t("category"),
                  item.category,
                  ["CONSUMABLE", "LINEN", "EQUIPMENT"],
                  (v) => set("category", v),
                  "categories"
                )}
                {textField(
                  t("expectedPerStay"),
                  item.expected_per_stay,
                  (v) => set("expected_per_stay", v),
                  "number",
                  false
                )}
              </div>
            ) : null}
            {kind === "WORKFLOW" ? (
              <>
                <div className="template-fields">
                  {selectField(
                    t("taskType"),
                    item.type,
                    taskTypeSchema.options,
                    (v) => set("type", v),
                    "taskTypes"
                  )}
                  {selectField(
                    t("due"),
                    item.due,
                    taskDueAnchorSchema.options,
                    (v) => set("due", v),
                    "anchors"
                  )}
                  {selectField(
                    t("priority"),
                    item.priority,
                    ["LOW", "NORMAL", "HIGH", "URGENT"],
                    (v) => set("priority", v),
                    "priorities"
                  )}
                  {textField(
                    t("checklistReference"),
                    item.checklistTemplateKey,
                    (v) => set("checklistTemplateKey", v || undefined),
                    "text",
                    false
                  )}
                </div>
                <p>{t("inlineChecklist")}</p>
                {checklistItems(list(item.checklist), (next) => set("checklist", next))}
              </>
            ) : null}
            {kind === "CHECKLIST"
              ? checklistItems(list(item.items), (next) => set("items", next))
              : null}
            {kind === "SERVICE_CATALOG" ? (
              <>
                <Bilingual
                  label={t("description")}
                  required={false}
                  value={item.description}
                  change={(v) =>
                    set("description", Object.values(record(v)).some(Boolean) ? v : undefined)
                  }
                />
                <div className="template-fields">
                  {selectField(
                    t("pricingModel"),
                    item.pricing_model,
                    ["FIXED", "PER_GUEST", "PER_DAY", "CUSTOM"],
                    (v) => set("pricing_model", v),
                    "pricingModels"
                  )}
                  {textField(
                    t("amount"),
                    item.amount,
                    (v) => set("amount", v || undefined),
                    "text",
                    item.pricing_model !== "CUSTOM"
                  )}
                  {textField(
                    t("currency"),
                    item.currency,
                    (v) => set("currency", v || undefined),
                    "text",
                    item.pricing_model !== "CUSTOM"
                  )}
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={item.available !== false}
                      onChange={(e) => set("available", e.target.checked)}
                    />
                    {t("available")}
                  </label>
                </div>
              </>
            ) : null}
            <button
              type="button"
              className="quiet-button"
              onClick={() => change(rows.filter((_, n) => n !== i))}
            >
              {t("remove")}
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="secondary-button"
        data-testid="template-add-entry"
        onClick={() =>
          change([
            ...rows,
            kind === "INVENTORY"
              ? { item: "", name: { en: "", fr: "" }, quantity: 0, unit: "", category: "CONSUMABLE" }
              : kind === "WORKFLOW"
                ? {
                    key: "",
                    title: { en: "", fr: "" },
                    type: "CHECKOUT_CLEANING",
                    due: "CHECK_OUT",
                    priority: "NORMAL",
                    checklist: []
                  }
                : kind === "CHECKLIST"
                  ? { key: "", name: { en: "", fr: "" }, items: [] }
                  : {
                      key: "",
                      name: { en: "", fr: "" },
                      pricing_model: "FIXED",
                      available: true
                    }
          ])
        }
      >
        {t("addEntry")}
      </button>
    </div>
  );
}
