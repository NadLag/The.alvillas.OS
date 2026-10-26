"use client";

import { useActionState, useMemo, useState } from "react";
import { z } from "zod";
import { useServerActionValidation, useZodForm } from "@/design-system/forms";
import { StatusBadge } from "@/design-system/shells";
import {
  activateConfigRuleAction,
  createConfigRuleAction,
  retireConfigRuleAction,
  type ConfigFormState
} from "@/modules/config/application/config-actions";
import type { ConfigAdminModel, ConfigRuleView } from "@/modules/config/application/config-service";
import { formatDateTime } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";

type ConfigLabels = {
  createTitle: string;
  historyTitle: string;
  previewTitle: string;
  key: string;
  customFeatureFlagKey: string;
  scopeType: string;
  scopeOrganization: string;
  scopeProperty: string;
  scopeId: string;
  noProperties: string;
  lifecycle: string;
  draft: string;
  active: string;
  retired: string;
  value: string;
  valuePlaceholder: string;
  effectiveFrom: string;
  effectiveTo: string;
  reason: string;
  createVersion: string;
  saving: string;
  activate: string;
  retire: string;
  empty: string;
  noDiff: string;
  changed: string;
  asOf: string;
  resolvedRule: string;
  noResolvedRule: string;
  version: string;
  scope: string;
  status: string;
  dates: string;
  diff: string;
  valuePreview: string;
  messages: Record<Exclude<ConfigFormState["messageKey"], undefined>, string>;
};

const initialState: ConfigFormState = { status: "idle" };

export function ConfigHistoryFilter({ properties, keys, initial, labels }: {
  properties: ConfigAdminModel["properties"]; keys: string[]; initial: { key: string; scopeType: string; scopeId: string };
  labels: { key: string; scope: string; property: string; organization: string; allScopes: string; allProperties: string; find: string };
}) {
  const [scope, setScope] = useState(initial.scopeType);
  return <form className="audit-filter-form" method="get" data-testid="config-history-filter">
    <label className="field"><span>{labels.key}</span><input name="ruleKey" list="config-history-keys" defaultValue={initial.key} />
      <datalist id="config-history-keys">{keys.map(key => <option key={key} value={key} />)}</datalist></label>
    <label className="field"><span>{labels.scope}</span><select name="ruleScopeType" value={scope} onChange={event => setScope(event.target.value)}>
      <option value="">{labels.allScopes}</option><option value="organization">{labels.organization}</option><option value="property">{labels.property}</option>
    </select></label>
    <label className="field"><span>{labels.property}</span><select name="ruleScopeId" disabled={scope !== "property"} defaultValue={initial.scopeId}>
      <option value="">{labels.allProperties}</option>{properties.map(property => <option key={property.id} value={property.id}>{property.name} - {property.city}</option>)}
    </select></label><button className="secondary-button" type="submit">{labels.find}</button>
  </form>;
}

function utcDateTime(date = new Date()): string {
  return date.toISOString().slice(0, 16);
}

function messageForState(state: ConfigFormState, labels: ConfigLabels): string | null {
  return state.messageKey ? labels.messages[state.messageKey] : null;
}

function FieldError({ state, name }: { state: ConfigFormState; name: string }) {
  const message = state.fieldErrors?.[name]?.[0];

  return message ? <p className="field-error">{message}</p> : null;
}

function scopeText(rule: ConfigRuleView, labels: ConfigLabels): string {
  return rule.scopeType === "organization" ? labels.scopeOrganization : rule.scopeLabel;
}

function lifecycleTone(lifecycle: ConfigRuleView["lifecycle"]): "neutral" | "success" | "warning" {
  if (lifecycle === "ACTIVE") {
    return "success";
  }

  if (lifecycle === "RETIRED") {
    return "warning";
  }

  return "neutral";
}

function lifecycleLabel(lifecycle: ConfigRuleView["lifecycle"], labels: ConfigLabels): string {
  if (lifecycle === "ACTIVE") {
    return labels.active;
  }

  if (lifecycle === "RETIRED") {
    return labels.retired;
  }

  return labels.draft;
}

function LifecycleActionForm({
  locale,
  rule,
  labels,
  mode
}: {
  locale: string;
  rule: ConfigRuleView;
  labels: ConfigLabels;
  mode: "activate" | "retire";
}) {
  const [state, formAction, pending] = useActionState(
    (mode === "activate" ? activateConfigRuleAction : retireConfigRuleAction).bind(null, locale),
    initialState
  );
  const message = messageForState(state, labels);

  return (
    <form action={formAction} className="config-lifecycle-form">
      <input name="ruleId" type="hidden" value={rule.id} />
      <label className="field">
        <span>{labels.effectiveFrom}</span>
        <input name="effectiveFrom" type="datetime-local" defaultValue={utcDateTime()} required />
      </label>
      <label className="field">
        <span>{labels.reason}</span>
        <input name="reason" required minLength={6} />
      </label>
      {message ? (
        <p className={state.status === "success" ? "form-status" : "form-error"} role={state.status === "success" ? "status" : "alert"}>
          {message}
        </p>
      ) : null}
      <button
        className={mode === "activate" ? "primary-button" : "secondary-button"}
        data-testid={mode === "activate" ? "config-rule-activate" : "config-rule-retire"}
        disabled={pending}
        type="submit"
      >
        {pending ? labels.saving : mode === "activate" ? labels.activate : labels.retire}
      </button>
    </form>
  );
}

function RuleRow({
  rule,
  locale,
  labels
}: {
  rule: ConfigRuleView;
  locale: string;
  labels: ConfigLabels;
}) {
  return (
    <article className="config-rule-row" data-testid="config-rule-row" data-rule-version={rule.version}>
      <div className="config-rule-summary">
        <span>
          <strong>{rule.key}</strong>
          <small>
            {labels.version} {rule.version} - {scopeText(rule, labels)}
          </small>
        </span>
        <StatusBadge tone={lifecycleTone(rule.lifecycle)}>{lifecycleLabel(rule.lifecycle, labels)}</StatusBadge>
      </div>
      <dl className="config-rule-meta">
        <div>
          <dt>{labels.dates}</dt>
          <dd>
            {formatDateTime(safeLocale(locale), rule.effectiveFrom, { timeZone: "UTC" })} - {rule.effectiveTo ? formatDateTime(safeLocale(locale), rule.effectiveTo, { timeZone: "UTC" }) : ""}
          </dd>
        </div>
        <div>
          <dt>{labels.reason}</dt>
          <dd>{rule.reason}</dd>
        </div>
        <div>
          <dt>{labels.diff}</dt>
          <dd>{rule.changedPaths.length > 0 ? `${labels.changed}: ${rule.changedPaths.join(", ")}` : labels.noDiff}</dd>
        </div>
      </dl>
      <details className="config-value-details">
        <summary>{labels.valuePreview}</summary>
        <pre>{rule.valueJson}</pre>
      </details>
      {rule.lifecycle === "DRAFT" ? (
        <LifecycleActionForm locale={locale} rule={rule} labels={labels} mode="activate" />
      ) : null}
      {rule.lifecycle === "ACTIVE" ? (
        <LifecycleActionForm locale={locale} rule={rule} labels={labels} mode="retire" />
      ) : null}
    </article>
  );
}

export function ConfigRuleAdmin({
  locale,
  model,
  labels
}: {
  locale: string;
  model: ConfigAdminModel;
  labels: ConfigLabels;
}) {
  const [state, formAction, pending] = useActionState(
    createConfigRuleAction.bind(null, locale),
    initialState
  );
  const defaultKey = model.catalogKeys[0] ?? "finance.commission";
  const [selectedKey, setSelectedKey] = useState(defaultKey);
  const [scopeType, setScopeType] = useState("organization");
  const schema = useMemo(
    () =>
      z.object({
        key: z.string().trim().min(1, labels.messages.validation),
        valueJson: z.string().trim().min(2, labels.messages.validation),
        effectiveFrom: z.string().trim().min(1, labels.messages.validation),
        reason: z.string().trim().min(6, labels.messages.validation)
      }),
    [labels.messages.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      key: defaultKey,
      valueJson: "",
      effectiveFrom: utcDateTime(),
      reason: ""
    }
  });
  const validateSubmit = useServerActionValidation(form, formAction);
  const keyField = form.register("key");
  const message = messageForState(state, labels);
  const hasProperties = model.properties.length > 0;

  return (
    <div className="config-admin-grid">
      <section className="workspace-side" aria-labelledby="config-create-title">
        <p className="panel-label" id="config-create-title">
          {labels.createTitle}
        </p>
        <form
          action={formAction}
          className="resource-form"
          data-testid="config-rule-create-form"
          onSubmit={validateSubmit}
        >
          <label className="field">
            <span>{labels.key}</span>
            <select
              data-testid="config-rule-key"
              required
              {...keyField}
              value={selectedKey}
              onChange={(event) => {
                setSelectedKey(event.target.value);
                void keyField.onChange(event);
              }}
            >
              {model.catalogKeys.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
            <FieldError state={state} name="key" />
          </label>
          <label className="field">
            <span>{labels.customFeatureFlagKey}</span>
            <input data-testid="config-rule-feature-key" name="customFeatureFlagKey" />
          </label>
          <div className="segmented-control">
            <label>
              <input
                defaultChecked
                name="scopeType"
                type="radio"
                value="organization"
                onChange={() => setScopeType("organization")}
              />
              <span>{labels.scopeOrganization}</span>
            </label>
            <label>
              <input
                name="scopeType"
                type="radio"
                value="property"
                onChange={() => setScopeType("property")}
              />
              <span>{labels.scopeProperty}</span>
            </label>
          </div>
          {scopeType === "property" ? (
            <label className="field">
              <span>{labels.scopeId}</span>
              <select
                data-testid="config-rule-scope-id"
                disabled={!hasProperties}
                name="scopeId"
                required={scopeType === "property"}
                defaultValue={model.properties[0]?.id ?? ""}
              >
                {model.properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name} - {property.city}
                  </option>
                ))}
              </select>
              {!hasProperties ? <p className="field-hint">{labels.noProperties}</p> : null}
              <FieldError state={state} name="scopeId" />
            </label>
          ) : null}
          <label className="field">
            <span>{labels.lifecycle}</span>
            <select data-testid="config-rule-lifecycle" name="lifecycle" defaultValue="ACTIVE">
              <option value="ACTIVE">{labels.active}</option>
              <option value="DRAFT">{labels.draft}</option>
            </select>
          </label>
          <label className="field">
            <span>{labels.value}</span>
            <textarea
              data-testid="config-rule-value"
              placeholder={labels.valuePlaceholder}
              rows={10}
              required
              {...form.register("valueJson")}
            />
            <FieldError state={state} name="valueJson" />
          </label>
          <div className="form-grid two">
            <label className="field">
              <span>{labels.effectiveFrom}</span>
              <input data-testid="config-rule-effective-from" required type="datetime-local" {...form.register("effectiveFrom")} />
              <FieldError state={state} name="effectiveFrom" />
            </label>
            <label className="field">
              <span>{labels.effectiveTo}</span>
              <input data-testid="config-rule-effective-to" name="effectiveTo" type="datetime-local" />
            </label>
          </div>
          <label className="field">
            <span>{labels.reason}</span>
            <input data-testid="config-rule-reason" required minLength={6} {...form.register("reason")} />
            <FieldError state={state} name="reason" />
          </label>
          {message ? (
            <p
              className={state.status === "success" ? "form-status" : "form-error"}
              data-testid="config-rule-form-message"
              role={state.status === "success" ? "status" : "alert"}
            >
              {message}
            </p>
          ) : null}
          <button
            className="primary-button"
            data-testid="config-rule-submit"
            disabled={pending || (scopeType === "property" && !hasProperties)}
            type="submit"
          >
            {pending ? labels.saving : labels.createVersion}
          </button>
        </form>
      </section>

      <section className="workspace-main">
        <div className="section-heading">
          <p className="panel-label">{labels.historyTitle}</p>
          <span>{model.rules.length}</span>
        </div>
        {model.preview ? (
          <aside className="config-preview" data-testid="config-preview">
            <p className="panel-label">{labels.previewTitle}</p>
            <strong>{model.preview.resolved ? labels.resolvedRule : labels.noResolvedRule}</strong>
            {model.preview.resolved ? (
              <span>
                {model.preview.resolved.key} - {scopeText(model.preview.resolved, labels)} - {labels.version}{" "}
                {model.preview.resolved.version}
              </span>
            ) : null}
          </aside>
        ) : null}
        {model.rules.length === 0 ? (
          <p className="empty-state" data-testid="config-rules-empty">
            {labels.empty}
          </p>
        ) : (
          <div className="config-rule-list">
            {model.rules.map((rule) => (
              <RuleRow key={rule.id} rule={rule} locale={locale} labels={labels} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
