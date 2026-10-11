ALTER TABLE financial_transaction
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX financial_transaction_org_idempotency_unique
  ON financial_transaction (organization_id, idempotency_key);

CREATE TABLE commission_snapshot (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES reservation(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES owner(id) ON DELETE RESTRICT,
  config_rule_id uuid REFERENCES config_rule(id) ON DELETE RESTRICT,
  share_bps integer NOT NULL,
  commission_rate_bps integer NOT NULL,
  commission_basis text NOT NULL,
  accrual_event text NOT NULL,
  snapshot_value jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_snapshot_org_reservation_owner_unique UNIQUE (
    organization_id,
    reservation_id,
    owner_id
  ),
  CONSTRAINT commission_snapshot_share_bps_check CHECK (share_bps > 0 AND share_bps <= 10000),
  CONSTRAINT commission_snapshot_rate_bps_check CHECK (
    commission_rate_bps >= 0 AND commission_rate_bps <= 10000
  ),
  CONSTRAINT commission_snapshot_basis_check CHECK (
    commission_basis IN (
      'GROSS_ACCOMMODATION',
      'NET_OF_OTA_FEES',
      'TOTAL_INCLUDING_SERVICES',
      'CUSTOM_FORMULA'
    )
  ),
  CONSTRAINT commission_snapshot_accrual_event_check CHECK (
    accrual_event IN ('ON_CONFIRMATION', 'ON_CHECKIN', 'ON_CHECKOUT', 'ON_RECEIPT')
  )
);

CREATE INDEX commission_snapshot_org_reservation_idx
  ON commission_snapshot (organization_id, reservation_id);

CREATE INDEX commission_snapshot_org_owner_property_idx
  ON commission_snapshot (organization_id, owner_id, property_id);

CREATE OR REPLACE FUNCTION app_assert_commission_snapshot_organization_consistency()
RETURNS trigger AS $$
DECLARE
  reservation_org uuid;
  reservation_property uuid;
  property_org uuid;
  owner_org uuid;
  config_org uuid;
BEGIN
  SELECT organization_id, property_id INTO reservation_org, reservation_property
  FROM reservation
  WHERE id = NEW.reservation_id;

  SELECT organization_id INTO property_org
  FROM property
  WHERE id = NEW.property_id;

  SELECT organization_id INTO owner_org
  FROM owner
  WHERE id = NEW.owner_id;

  IF NEW.config_rule_id IS NOT NULL THEN
    SELECT organization_id INTO config_org
    FROM config_rule
    WHERE id = NEW.config_rule_id;
  ELSE
    config_org := NEW.organization_id;
  END IF;

  IF NEW.organization_id <> reservation_org
    OR NEW.organization_id <> property_org
    OR NEW.organization_id <> owner_org
    OR NEW.organization_id <> config_org
    OR NEW.property_id <> reservation_property THEN
    RAISE EXCEPTION 'commission snapshot organization mismatch';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commission_snapshot_organization_consistency
BEFORE INSERT OR UPDATE ON commission_snapshot
FOR EACH ROW EXECUTE FUNCTION app_assert_commission_snapshot_organization_consistency();

CREATE TRIGGER commission_snapshot_no_update
BEFORE UPDATE ON commission_snapshot
FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE TRIGGER commission_snapshot_no_delete
BEFORE DELETE ON commission_snapshot
FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

ALTER TABLE commission_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_snapshot FORCE ROW LEVEL SECURITY;

CREATE POLICY commission_snapshot_tenant_isolation ON commission_snapshot
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
