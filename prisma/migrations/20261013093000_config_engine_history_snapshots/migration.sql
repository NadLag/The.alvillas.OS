ALTER TABLE config_rule
  ADD COLUMN lifecycle text NOT NULL DEFAULT 'ACTIVE',
  ADD CONSTRAINT config_rule_lifecycle_check CHECK (lifecycle IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  ADD CONSTRAINT config_rule_effective_range_check CHECK (
    effective_to IS NULL OR effective_to > effective_from
  );

CREATE INDEX config_rule_org_key_lifecycle_effective_idx
  ON config_rule (organization_id, key, scope_type, lifecycle, effective_from);

CREATE OR REPLACE FUNCTION app_prevent_config_rule_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'config_rule is append-only';
END;
$$;

CREATE TRIGGER config_rule_no_update
BEFORE UPDATE ON config_rule
FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();

CREATE TRIGGER config_rule_no_delete
BEFORE DELETE ON config_rule
FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();

REVOKE UPDATE, DELETE ON config_rule FROM PUBLIC;

CREATE TABLE reservation_config_snapshot (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES reservation(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  config_rule_id uuid REFERENCES config_rule(id) ON DELETE RESTRICT,
  key text NOT NULL,
  scope_type text NOT NULL,
  scope_id uuid,
  version integer NOT NULL,
  snapshot_value jsonb NOT NULL,
  resolved_at timestamptz NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_config_snapshot_value_check CHECK (jsonb_typeof(snapshot_value) = 'object'),
  CONSTRAINT reservation_config_snapshot_org_reservation_key_unique UNIQUE (
    organization_id,
    reservation_id,
    key
  )
);

CREATE INDEX reservation_config_snapshot_org_reservation_idx
  ON reservation_config_snapshot (organization_id, reservation_id);

CREATE INDEX reservation_config_snapshot_org_property_key_idx
  ON reservation_config_snapshot (organization_id, property_id, key);

CREATE OR REPLACE FUNCTION app_assert_reservation_config_snapshot_organization_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation_org uuid;
  property_org uuid;
  config_org uuid;
BEGIN
  SELECT organization_id INTO reservation_org
  FROM reservation
  WHERE id = NEW.reservation_id;

  SELECT organization_id INTO property_org
  FROM property
  WHERE id = NEW.property_id;

  IF NEW.config_rule_id IS NOT NULL THEN
    SELECT organization_id INTO config_org
    FROM config_rule
    WHERE id = NEW.config_rule_id;
  END IF;

  IF reservation_org IS DISTINCT FROM NEW.organization_id
    OR property_org IS DISTINCT FROM NEW.organization_id
    OR (NEW.config_rule_id IS NOT NULL AND config_org IS DISTINCT FROM NEW.organization_id) THEN
    RAISE EXCEPTION 'reservation_config_snapshot organization mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_config_snapshot_organization_consistency
BEFORE INSERT OR UPDATE ON reservation_config_snapshot
FOR EACH ROW EXECUTE FUNCTION app_assert_reservation_config_snapshot_organization_consistency();

CREATE TRIGGER reservation_config_snapshot_no_update
BEFORE UPDATE ON reservation_config_snapshot
FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();

CREATE TRIGGER reservation_config_snapshot_no_delete
BEFORE DELETE ON reservation_config_snapshot
FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();

ALTER TABLE reservation_config_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_config_snapshot FORCE ROW LEVEL SECURITY;

CREATE POLICY reservation_config_snapshot_tenant_isolation ON reservation_config_snapshot
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
