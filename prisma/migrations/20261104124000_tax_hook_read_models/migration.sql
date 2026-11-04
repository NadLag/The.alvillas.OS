BEGIN;
-- Tax interfaces read immutable versions of the original finance.tax configuration.
CREATE VIEW tax_rate WITH (security_invoker=true,security_barrier=true) AS
SELECT policy.organization_id,policy.id AS policy_rule_id,policy.version AS policy_version,
 policy.scope_type,policy.scope_id,policy.lifecycle,policy.effective_from,policy.effective_to,policy.archived_at,
 (entry.ordinality-1)::integer AS tax_index,entry.value->>'key' AS tax_key,entry.value AS configured_value
FROM config_rule policy CROSS JOIN LATERAL jsonb_array_elements(
 CASE WHEN jsonb_typeof(policy.value->'taxes')='array' THEN policy.value->'taxes' ELSE '[]'::jsonb END
) WITH ORDINALITY AS entry(value,ordinality)
WHERE policy.key='finance.tax';

CREATE VIEW tax_category WITH (security_invoker=true,security_barrier=true) AS
SELECT DISTINCT rate.organization_id,rate.policy_rule_id,rate.policy_version,
 rate.scope_type,rate.scope_id,rate.lifecycle,rate.effective_from,rate.effective_to,rate.archived_at,
 rate.configured_value#>>'{tax_hook,category,key}' AS category_key,
 rate.configured_value#>'{tax_hook,category,labels}' AS labels
FROM tax_rate rate
WHERE jsonb_typeof(rate.configured_value#>'{tax_hook,category}')='object';

CREATE VIEW tax_rule WITH (security_invoker=true,security_barrier=true) AS
SELECT rate.organization_id,rate.policy_rule_id,rate.policy_version,
 rate.scope_type,rate.scope_id,rate.lifecycle,rate.effective_from,rate.effective_to,rate.archived_at,
 rate.tax_index,rate.tax_key,rate.configured_value#>>'{tax_hook,category,key}' AS category_key,
 (selector.ordinality-1)::integer AS context_index,selector.value AS context
FROM tax_rate rate CROSS JOIN LATERAL jsonb_array_elements(
 CASE WHEN jsonb_typeof(rate.configured_value#>'{tax_hook,contexts}')='array'
  THEN rate.configured_value#>'{tax_hook,contexts}' ELSE '[]'::jsonb END
) WITH ORDINALITY AS selector(value,ordinality);

COMMIT;
