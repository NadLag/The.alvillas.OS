BEGIN;

-- Explicit empty arrays are approved configuration; missing source families are never a complete review.
ALTER TABLE property_onboarding_revision ADD CONSTRAINT property_onboarding_configuration_manifest_shape
 CHECK(step<>'REVIEW' OR coalesce(
  jsonb_typeof(source_snapshot->'parent')='object'
  AND jsonb_typeof(source_snapshot->'ancestry')='array' AND jsonb_array_length(source_snapshot->'ancestry')=9
  AND jsonb_typeof(source_snapshot->'agreement')='object'
  AND jsonb_typeof(source_snapshot->'agreementRules')='array' AND jsonb_array_length(source_snapshot->'agreementRules')=7
  AND jsonb_typeof(source_snapshot->'operatingProfileHead')='object'
  AND jsonb_typeof(source_snapshot->'operatingRule') IN('object','null')
  AND jsonb_typeof(source_snapshot->'team')='object' AND ((source_snapshot->'team')-ARRAY['pins','fingerprint'])='{}'::jsonb
  AND jsonb_typeof(source_snapshot#>'{team,pins}')='array' AND source_snapshot#>>'{team,fingerprint}' ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(source_snapshot->'bookingChannels')='object' AND ((source_snapshot->'bookingChannels')-ARRAY['pins','fingerprint'])='{}'::jsonb
  AND jsonb_typeof(source_snapshot#>'{bookingChannels,pins}')='array' AND source_snapshot#>>'{bookingChannels,fingerprint}' ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(source_snapshot->'inventory')='object' AND jsonb_typeof(source_snapshot#>'{inventory,rule}')='object'
  AND jsonb_typeof(source_snapshot#>'{inventory,binding}') IN('object','null')
  AND jsonb_typeof(source_snapshot#>'{inventory,templates}')='array' AND jsonb_array_length(source_snapshot#>'{inventory,templates}')<=1
  AND jsonb_typeof(source_snapshot#>'{inventory,scopes}')='array' AND source_snapshot#>>'{inventory,fingerprint}' ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(source_snapshot->'services')='object' AND jsonb_typeof(source_snapshot#>'{services,rule}')='object'
  AND jsonb_typeof(source_snapshot#>'{services,binding}') IN('object','null')
  AND jsonb_typeof(source_snapshot#>'{services,templates}')='array' AND jsonb_array_length(source_snapshot#>'{services,templates}')<=1
  AND jsonb_typeof(source_snapshot#>'{services,scopes}')='array' AND source_snapshot#>>'{services,fingerprint}' ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(source_snapshot->'workflows')='object' AND jsonb_typeof(source_snapshot#>'{workflows,rules}')='array'
  AND jsonb_array_length(source_snapshot#>'{workflows,rules}')=3 AND jsonb_typeof(source_snapshot#>'{workflows,binding}')='object'
  AND jsonb_typeof(source_snapshot#>'{workflows,templates}')='array' AND jsonb_array_length(source_snapshot#>'{workflows,templates}')=1
  AND jsonb_typeof(source_snapshot#>'{workflows,scopes}')='array' AND source_snapshot#>>'{workflows,fingerprint}' ~ '^[a-f0-9]{64}$',false));

COMMIT;
