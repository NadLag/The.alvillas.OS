CREATE TABLE property_operating_profile (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  cleaning_enabled boolean NOT NULL DEFAULT true,
  cleaning_frequency text NOT NULL DEFAULT 'BETWEEN_STAYS',
  inspection_enabled boolean NOT NULL DEFAULT true,
  inspection_frequency text NOT NULL DEFAULT 'CHECKOUT',
  pool_service_enabled boolean NOT NULL DEFAULT false,
  pool_service_frequency text NOT NULL DEFAULT 'NONE',
  garden_service_enabled boolean NOT NULL DEFAULT false,
  garden_service_frequency text NOT NULL DEFAULT 'NONE',
  laundry_managed boolean NOT NULL DEFAULT true,
  linen_managed boolean NOT NULL DEFAULT true,
  maintenance_tracking_enabled boolean NOT NULL DEFAULT true,
  preventive_maintenance_frequency text NOT NULL DEFAULT 'ON_DEMAND',
  mid_stay_cleaning_enabled boolean NOT NULL DEFAULT false,
  mid_stay_cleaning_rule_key text,
  breakfast_available boolean NOT NULL DEFAULT false,
  chef_available boolean NOT NULL DEFAULT false,
  transfers_available boolean NOT NULL DEFAULT false,
  groceries_available boolean NOT NULL DEFAULT false,
  wellness_available boolean NOT NULL DEFAULT false,
  other_services jsonb NOT NULL DEFAULT '[]'::jsonb,
  automation_notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_operating_profile_property_unique UNIQUE (property_id),
  CONSTRAINT property_operating_profile_other_services_array_check CHECK (jsonb_typeof(other_services) = 'array'),
  CONSTRAINT property_operating_profile_cleaning_frequency_check CHECK (cleaning_frequency IN ('NONE', 'ON_DEMAND', 'BETWEEN_STAYS', 'DAILY', 'WEEKLY', 'MONTHLY', 'CHECKIN', 'CHECKOUT', 'CUSTOM_RULE')),
  CONSTRAINT property_operating_profile_inspection_frequency_check CHECK (inspection_frequency IN ('NONE', 'ON_DEMAND', 'BETWEEN_STAYS', 'DAILY', 'WEEKLY', 'MONTHLY', 'CHECKIN', 'CHECKOUT', 'CUSTOM_RULE')),
  CONSTRAINT property_operating_profile_pool_frequency_check CHECK (pool_service_frequency IN ('NONE', 'ON_DEMAND', 'BETWEEN_STAYS', 'DAILY', 'WEEKLY', 'MONTHLY', 'CHECKIN', 'CHECKOUT', 'CUSTOM_RULE')),
  CONSTRAINT property_operating_profile_garden_frequency_check CHECK (garden_service_frequency IN ('NONE', 'ON_DEMAND', 'BETWEEN_STAYS', 'DAILY', 'WEEKLY', 'MONTHLY', 'CHECKIN', 'CHECKOUT', 'CUSTOM_RULE')),
  CONSTRAINT property_operating_profile_maintenance_frequency_check CHECK (preventive_maintenance_frequency IN ('NONE', 'ON_DEMAND', 'BETWEEN_STAYS', 'DAILY', 'WEEKLY', 'MONTHLY', 'CHECKIN', 'CHECKOUT', 'CUSTOM_RULE')),
  CONSTRAINT property_operating_profile_midstay_rule_check CHECK (
    NOT mid_stay_cleaning_enabled OR
    (mid_stay_cleaning_rule_key IS NOT NULL AND mid_stay_cleaning_rule_key ~ '^[a-z0-9_.-]{1,120}$')
  )
);

CREATE INDEX property_operating_profile_org_property_idx
  ON property_operating_profile (organization_id, property_id);

CREATE INDEX property_operating_profile_org_services_idx
  ON property_operating_profile (
    organization_id,
    cleaning_enabled,
    inspection_enabled,
    pool_service_enabled,
    garden_service_enabled,
    mid_stay_cleaning_enabled
  );

CREATE OR REPLACE FUNCTION app_assert_property_operating_profile_organization_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  property_org uuid;
BEGIN
  SELECT organization_id INTO property_org
  FROM property
  WHERE id = NEW.property_id;

  IF property_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'property operating profile organization mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER property_operating_profile_organization_consistency
BEFORE INSERT OR UPDATE ON property_operating_profile
FOR EACH ROW EXECUTE FUNCTION app_assert_property_operating_profile_organization_consistency();

CREATE TRIGGER property_operating_profile_no_delete
BEFORE DELETE ON property_operating_profile
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

ALTER TABLE property_operating_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_operating_profile FORCE ROW LEVEL SECURITY;

CREATE POLICY property_operating_profile_tenant_isolation ON property_operating_profile
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

INSERT INTO property_operating_profile (
  organization_id,
  property_id,
  pool_service_enabled,
  pool_service_frequency,
  garden_service_enabled,
  garden_service_frequency,
  created_by
)
SELECT
  organization_id,
  id,
  has_pool,
  CASE WHEN has_pool THEN 'ON_DEMAND' ELSE 'NONE' END,
  has_garden,
  CASE WHEN has_garden THEN 'ON_DEMAND' ELSE 'NONE' END,
  created_by
FROM property
WHERE archived_at IS NULL
ON CONFLICT (property_id) DO NOTHING;
