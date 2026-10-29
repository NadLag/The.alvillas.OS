"use client";
import { memo, useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { ConfigAdminModel } from "../application/config-service";

/** Keep the authorized roster complete while bounding native selector rendering. */
export const ConfigPropertySelect = memo(function ConfigPropertySelect({ properties, name, label, initialValue, emptyLabel, disabled, required, testId }: {
  properties: ConfigAdminModel["properties"]; name: string; label: string; initialValue: string; emptyLabel?: string;
  disabled?: boolean; required?: boolean; testId: string;
}) {
  const t = useTranslations("Configuration"), id = useId();
  const [query, setQuery] = useState(""), [limit, setLimit] = useState(50), [selected, setSelected] = useState(initialValue);
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? properties.filter(property => `${property.name} - ${property.city}`.toLocaleLowerCase().includes(normalized) || property.id.includes(normalized)) : properties;
  }, [properties, query]);
  const chosen = properties.find(property => property.id === selected), page = matches.slice(0, limit);
  const options = chosen && !page.some(property => property.id === chosen.id) ? [chosen, ...page] : page;
  return <div className="field">
    <label htmlFor={`${id}-search`}>{t("form.propertySearch")}</label>
    <input id={`${id}-search`} type="search" data-testid={`${testId}-search`} value={query} maxLength={160} disabled={disabled}
      onChange={event => { setQuery(event.target.value); setLimit(50); }} />
    <label htmlFor={id}>{label}</label>
    <select id={id} name={name} value={chosen ? chosen.id : ""} data-testid={testId} disabled={disabled} required={required} onChange={event => setSelected(event.target.value)}>
      <option value="" disabled={!emptyLabel}>{emptyLabel ?? label}</option>
      {options.map(property => <option key={property.id} value={property.id}>{property.name} - {property.city}</option>)}
    </select>
    {matches.length > limit ? <button className="quiet-button" type="button" disabled={disabled} data-testid={`${testId}-more`} onClick={() => setLimit(value => value + 50)}>{t("form.moreProperties")}</button> : null}
  </div>;
});
