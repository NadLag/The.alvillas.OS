"use client";

import { useActionState, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { automationAction, type AutomationFormState } from "./actions";
import type { automationAdmin } from "./service";
import { automationRuleSchema } from "./rule";
import { automationEvents } from "./events";
import defaults from "@/platform/config/defaults/automations.json";
const standardAutomationLibrary = defaults.rules;
import type { AutomationRule } from "./rule";
import { localizedText } from "@/i18n/content";
import type { AppLocale } from "@/i18n/routing";
import { formatDateTime } from "@/i18n/format";

type Model = Awaited<ReturnType<typeof automationAdmin>>;
const initial: AutomationFormState = { status: "idle" };
function Feedback({ state }: { state: AutomationFormState }) {
  const t = useTranslations("Automation");
  return (
    <>
      {state.message ? (
        <p
          role={state.status === "error" ? "alert" : "status"}
          data-testid="automation-feedback"
        >
          {t(`messages.${state.message}`)}
        </p>
      ) : null}
      {state.preview ? (
        <div className="automation-preview" data-testid="automation-preview">
          <strong>{t(state.preview.matched ? "matched" : "unmatched")}</strong>
          <pre dir="ltr">{JSON.stringify(state.preview, null, 2)}</pre>
        </div>
      ) : null}
    </>
  );
}
function Command({
  locale,
  command,
  fields,
  button,
  children,
}: {
  locale: string;
  command: string;
  fields: Record<string, string>;
  button: string;
  children?: React.ReactNode;
}) {
  const [state, action, pending] = useActionState(
      automationAction.bind(null, locale),
      initial,
    ),
    t = useTranslations("Automation");
  return (
    <form action={action} className="automation-command">
      <input type="hidden" name="command" value={command} />
      {Object.entries(fields).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      {children}
      {command !== "preview" ? (
        <label>
          {t("reason")}
          <input
            name="reason"
            minLength={6}
            maxLength={500}
            required
            disabled={pending}
          />
        </label>
      ) : null}
      <button className="secondary-button" disabled={pending}>
        {pending ? t("working") : button}
      </button>
      <Feedback state={state} />
    </form>
  );
}
function Editor({
  locale,
  properties,
  version,
  effectiveDefault,
  canConfigureOrganization,
}: {
  locale: string;
  properties: Model["properties"];
  version?: Model["versions"][number];
  effectiveDefault: string;
  canConfigureOrganization: boolean;
}) {
  const t = useTranslations("Automation"),
    [state, action, pending] = useActionState(
      automationAction.bind(null, locale),
      initial,
    );
  const seed = version
    ? automationRuleSchema.parse(version.value)
    : automationRuleSchema.parse(standardAutomationLibrary[1].rule);
  const [rule, setRule] = useState<AutomationRule>(seed),
    [conditions, setConditions] = useState(
      JSON.stringify(seed.conditions, null, 2),
    ),
    [actions, setActions] = useState(JSON.stringify(seed.actions, null, 2)),
    [invalid, setInvalid] = useState(false);
  function jsonRule() {
    try {
      const parsed = automationRuleSchema.safeParse({
        ...rule,
        conditions: JSON.parse(conditions) as unknown,
        actions: JSON.parse(actions) as unknown,
      });
      return parsed.success ? JSON.stringify(parsed.data) : "";
    } catch {
      return "";
    }
  }
  const serialized = jsonRule();
  return (
    <section
      className="workspace-main automation-editor"
      aria-labelledby="automation-editor-title"
    >
      <h2 id="automation-editor-title">
        {t(version ? "newVersion" : "create")}
      </h2>
      <label>
        {t("startFrom")}
        <select
          disabled={pending}
          value=""
          onChange={(e) => {
            const r = automationRuleSchema.parse(
              standardAutomationLibrary[Number(e.target.value)].rule,
            );
            setRule(r);
            setConditions(JSON.stringify(r.conditions, null, 2));
            setActions(JSON.stringify(r.actions, null, 2));
          }}
        >
          <option value="" disabled>
            {t("chooseTemplate")}
          </option>
          {standardAutomationLibrary.map((v, i) => (
            <option key={v.key} value={i}>
              {localizedText(v.rule.name, locale as AppLocale)}
            </option>
          ))}
        </select>
      </label>
      <form
        data-testid="automation-create-form"
        action={action}
        onSubmit={(e) => {
          if (!serialized) {
            e.preventDefault();
            setInvalid(true);
          } else setInvalid(false);
        }}
      >
        <input type="hidden" name="command" value="save" />
        <input type="hidden" name="ruleJson" value={serialized} />
        <div className="automation-fields">
          <label>
            {t("key")}
            <input
              name="key"
              required
              pattern="[a-z][a-z0-9_.-]{0,99}"
              maxLength={100}
              defaultValue={version?.key.slice(16)}
              readOnly={Boolean(version)}
              disabled={pending}
            />
          </label>
          <label>
            {t("property")}
            <select
              name="propertyId"
              defaultValue={version ? version.scopeId ?? "" : properties[0]?.id ?? ""}
              disabled={pending}
            >
              {canConfigureOrganization ? <option value="">{t("organization")}</option> : null}
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("nameEn")}
            <input
              value={rule.name.en}
              onChange={(e) =>
                setRule({
                  ...rule,
                  name: version
                    ? { ...rule.name, en: e.target.value }
                    : { en: e.target.value, fr: rule.name.fr },
                })
              }
              required
              disabled={pending}
            />
          </label>
          <label>
            {t("nameFr")}
            <input
              value={rule.name.fr}
              onChange={(e) =>
                setRule({
                  ...rule,
                  name: version
                    ? { ...rule.name, fr: e.target.value }
                    : { en: rule.name.en, fr: e.target.value },
                })
              }
              required
              disabled={pending}
            />
          </label>
          <label>
            {t("event")}
            <select
              value={rule.event}
              onChange={(e) =>
                setRule({
                  ...rule,
                  event:
                    automationEvents.find(
                      (event) => event === e.target.value,
                    ) ?? rule.event,
                })
              }
              disabled={pending}
            >
              {automationEvents.map((event) => (
                <option key={event} value={event}>{event === "SupplierInvoiceSubmitted" ? t("invoiceSubmittedEvent") : event}</option>
              ))}
            </select>
          </label>
          <label>
            {t("lifecycle")}
            <select name="lifecycle" disabled={pending}>
              <option value="DRAFT">{t("draft")}</option>
              <option value="ACTIVE">{t("active")}</option>
            </select>
          </label>
          <label>
            {t("effectiveFrom")}
            <input
              type="datetime-local"
              name="effectiveFrom"
              required
              defaultValue={effectiveDefault}
              disabled={pending}
            />
          </label>
          <label>
            {t("effectiveTo")}
            <input
              type="datetime-local"
              name="effectiveTo"
              disabled={pending}
            />
          </label>
        </div>
        <label>
          {t("conditions")}
          <textarea
            aria-label={t("conditions")}
            dir="ltr"
            rows={7}
            value={conditions}
            onChange={(e) => setConditions(e.target.value)}
            aria-describedby="automation-condition-help"
            disabled={pending}
          />
        </label>
        <p id="automation-condition-help" className="muted-copy">
          {t("conditionHelp")}
        </p>
        <label>
          {t("actions")}
          <textarea
            aria-label={t("actions")}
            dir="ltr"
            rows={12}
            value={actions}
            onChange={(e) => setActions(e.target.value)}
            aria-describedby="automation-action-help"
            disabled={pending}
          />
        </label>
        <p id="automation-action-help" className="muted-copy">
          {t("actionHelp")}
        </p>
        <div className="automation-fields">
          <label>
            {t("attempts")}
            <input
              type="number"
              min={1}
              max={25}
              required
              value={rule.retry.max_attempts}
              disabled={pending}
              onChange={(e) =>
                setRule({
                  ...rule,
                  retry: {
                    ...rule.retry,
                    max_attempts: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            {t("retryDelay")}
            <input
              type="number"
              min={1}
              max={86400}
              required
              value={rule.retry.delay_seconds}
              disabled={pending}
              onChange={(e) =>
                setRule({
                  ...rule,
                  retry: {
                    ...rule.retry,
                    delay_seconds: Number(e.target.value),
                  },
                })
              }
            />
          </label>
        </div>
        <label>
          {t("idempotency")}
          <input
            dir="ltr"
            value={rule.idempotency_key ?? ""}
            disabled={pending}
            onChange={(e) =>
              setRule({ ...rule, idempotency_key: e.target.value || undefined })
            }
          />
        </label>
        <label className="automation-checkbox">
          <input
            type="checkbox"
            checked={Boolean(rule.schedule)}
            disabled={pending}
            onChange={(e) =>
              setRule({
                ...rule,
                schedule: e.target.checked
                  ? { hour: 0, minute: 0, weekdays: [0, 1, 2, 3, 4, 5, 6] }
                  : undefined,
              })
            }
          />
          {t("scheduled")}
        </label>
        {rule.schedule ? (
          <div className="automation-fields">
            <label>
              {t("hour")}
              <input
                type="number"
                min={0}
                max={23}
                required
                value={rule.schedule.hour}
                onChange={(e) =>
                  setRule({
                    ...rule,
                    schedule: {
                      ...rule.schedule!,
                      hour: Number(e.target.value),
                    },
                  })
                }
                disabled={pending}
              />
            </label>
            <label>
              {t("minute")}
              <input
                type="number"
                min={0}
                max={59}
                required
                value={rule.schedule.minute}
                onChange={(e) =>
                  setRule({
                    ...rule,
                    schedule: {
                      ...rule.schedule!,
                      minute: Number(e.target.value),
                    },
                  })
                }
                disabled={pending}
              />
            </label>
            <label>
              {t("weekdays")}
              <input
                required
                defaultValue={rule.schedule.weekdays.join(",")}
                pattern="[0-6](,[0-6])*"
                onChange={(e) =>
                  setRule({
                    ...rule,
                    schedule: {
                      ...rule.schedule!,
                      weekdays: e.target.value.split(",").map(Number),
                    },
                  })
                }
                disabled={pending}
              />
            </label>
            <label>
              {t("timezone")}
              <input
                value={rule.schedule.timezone ?? ""}
                onChange={(e) =>
                  setRule({
                    ...rule,
                    schedule: {
                      ...rule.schedule!,
                      timezone: e.target.value || undefined,
                    },
                  })
                }
                disabled={pending}
              />
            </label>
          </div>
        ) : null}
        <label>
          {t("reason")}
          <input
            name="reason"
            minLength={6}
            maxLength={500}
            required
            disabled={pending}
          />
        </label>
        {invalid ? <p role="alert">{t("messages.invalid")}</p> : null}
        <Feedback state={state} />
        <button className="primary-button" disabled={pending}>
          {pending ? t("working") : t("save")}
        </button>
      </form>
    </section>
  );
}
export function AutomationAdmin({
  model,
  locale,
}: {
  model: Model;
  locale: string;
}) {
  const t = useTranslations("Automation"),
    activeLocale = useLocale(),
    [editing, setEditing] = useState<Model["versions"][number]>();
  const latest = new Map<string, Model["versions"][number]>();
  for (const v of model.versions) {
    const key =
      v.key +
      ":" +
      v.scopeId +
      ":" +
      (v.lifecycle === "DRAFT" ? "draft" : "published");
    if (!latest.has(key)) latest.set(key, v);
  }
  const visibleVersions = [...latest.values()].filter(
    (v) =>
      v.lifecycle !== "DRAFT" ||
      v.version > (latest.get(`${v.key}:${v.scopeId}:published`)?.version ?? 0),
  );
  return (
    <div className="automation-workspace">
      <section className="workspace-main">
        <h2>{t("rules")}</h2>
        <form method="get" className="automation-command">
          <label>
            {t("property")}
            <select name="propertyId" defaultValue={model.selectedPropertyId}>
              <option value="">{t("allProperties")}</option>
              {model.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary-button">{t("filter")}</button>
        </form>
        <p className="muted-copy">{t("safety")}</p>
        {!latest.size ? (
          <p>{t("empty")}</p>
        ) : (
          <ul className="automation-rules">
            {visibleVersions.map((v) => {
              const rule = automationRuleSchema.parse(v.value);
              return (
                <li key={v.id} data-testid="automation-rule">
                  <div className="automation-rule-heading">
                    <h3>
                      {localizedText(rule.name, activeLocale as AppLocale)}
                    </h3>
                    <span className="status-badge">
                      {t(
                        v.lifecycle === "DRAFT"
                          ? "draft"
                          : rule.enabled
                            ? "active"
                            : "paused",
                      )}{" "}
                      · {t("version", { number: v.version })}
                    </span>
                  </div>
                  <p>
                    {v.key} · {rule.event === "SupplierInvoiceSubmitted" ? t("invoiceSubmittedEvent") : rule.event}
                  </p>
                  <p>
                    {v.scopeType === "property"
                      ? model.properties.find((p) => p.id === v.scopeId)?.name
                      : t("organization")}
                  </p>
                  <button
                    className="quiet-button"
                    onClick={() => setEditing(v)}
                  >
                    {t("edit")}
                  </button>
                  <Command
                    locale={locale}
                    command="state"
                    fields={{
                      ruleId: v.id,
                      enabled: String(v.lifecycle === "DRAFT" || !rule.enabled),
                    }}
                    button={t(
                      v.lifecycle === "DRAFT"
                        ? "activate"
                        : rule.enabled
                          ? "pause"
                          : "resume",
                    )}
                  />
                  <Command
                    locale={locale}
                    command="preview"
                    fields={{ ruleId: v.id }}
                    button={t("preview")}
                  >
                    <label>
                      {t("sourceEvent")}
                      <select name="eventId" required>
                        <option value="">{t("chooseEvent")}</option>
                        {model.sources.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.type === "SupplierInvoiceSubmitted" ? t("invoiceSubmittedEvent") : s.type} ·{" "}
                            {formatDateTime(
                              activeLocale as AppLocale,
                              new Date(s.occurredAt),
                            )}
                          </option>
                        ))}
                      </select>
                    </label>
                  </Command>
                  <details>
                    <summary>{t("definition")}</summary>
                    <pre dir="ltr">{JSON.stringify(rule, null, 2)}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
        {model.versions.length === 100 ? (
          <a
            className="secondary-button"
            href={`?propertyId=${model.selectedPropertyId}&versionsBefore=${encodeURIComponent(model.versions.at(-1)!.createdAt.toISOString())}&versionsBeforeId=${model.versions.at(-1)!.id}`}
          >
            {t("olderVersions")}
          </a>
        ) : null}
        <details>
          <summary>{t("library")}</summary>
          <p>{t("libraryHelp")}</p>
          <Command
            locale={locale}
            command="library"
            fields={{}}
            button={t("install")}
          >
            <label>
              {t("property")}
              <select name="propertyId" required>
                {model.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </Command>
        </details>
      </section>
      <Editor
        key={editing?.id ?? "new"}
        locale={locale}
        properties={model.properties}
        version={editing}
        effectiveDefault={model.effectiveDefault}
          canConfigureOrganization={model.canConfigureOrganization}
      />
      <section className="workspace-main automation-history">
        <h2>{t("history")}</h2>
        {!model.runs.length ? (
          <p>{t("noRuns")}</p>
        ) : (
          <ul className="automation-rules">
            {model.runs.map((run) => (
              <li key={run.id} data-testid="automation-run">
                <div className="automation-rule-heading">
                  <h3>{run.ruleKey}</h3>
                  <span className="status-badge">
                    {run.status ? t(`statuses.${run.status}`) : t("restrictedOutcome")}
                  </span>
                </div>
                <p>
                  {run.createdAt
                    ? formatDateTime(
                        activeLocale as AppLocale,
                        new Date(run.createdAt),
                      )
                    : ""}{" "}
                  {run.attemptCount !== undefined ? <>· {t("attemptCount", { count: run.attemptCount })}</> : null}
                </p>
                {run.errorCode ? (
                  <p role="status">
                    {t("failureHint")} <code>{run.errorCode}</code>
                  </p>
                ) : null}
                <details>
                  <summary>{t("executionDetails")}</summary>
                  <pre dir="ltr">
                    {JSON.stringify(
                      {
                        inputs: run.inputs,
                        outputs: run.outputs,
                        attempts: run.attempts,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                {run.id && run.status &&
                !["SUCCEEDED", "SKIPPED"].includes(run.status ?? "") ? (
                  <Command
                    locale={locale}
                    command="replay"
                    fields={{ runId: run.id }}
                    button={t("replay")}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {model.runs.length === 50 ? (
          <a
            className="secondary-button"
            href={`?propertyId=${model.selectedPropertyId}&before=${encodeURIComponent(model.runs.at(-1)?.createdAt ?? "")}&beforeId=${model.runs.at(-1)?.id ?? ""}`}
          >
            {t("older")}
          </a>
        ) : null}
        <h3>{t("suggestions")}</h3>
        {model.suggestions.length ? (
          <ul>
            {model.suggestions.map((s) => (
              <li key={s.id}>
                {localizedText(
                  s.title as Record<string, string>,
                  activeLocale as AppLocale,
                )}{" "}
                · {s.itemKey} · {s.quantity}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t("noSuggestions")}</p>
        )}
      </section>
    </div>
  );
}
