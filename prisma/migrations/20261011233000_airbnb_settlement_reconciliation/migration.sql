CREATE TABLE airbnb_settlement (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES reservation(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  source_reservation_id text NOT NULL,
  source_payout_id text NOT NULL,
  source_transaction_id text NOT NULL,
  currency char(3) NOT NULL REFERENCES currency(code) ON DELETE RESTRICT,
  gross_amount numeric(18, 2) NOT NULL,
  platform_fee numeric(18, 2) NOT NULL,
  expected_payout numeric(18, 2) NOT NULL,
  actual_receipt numeric(18, 2) NOT NULL,
  idempotency_key text NOT NULL,
  imported_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT airbnb_settlement_org_source_transaction_unique UNIQUE (
    organization_id,
    source_transaction_id
  ),
  CONSTRAINT airbnb_settlement_org_idempotency_unique UNIQUE (
    organization_id,
    idempotency_key
  ),
  CONSTRAINT airbnb_settlement_gross_positive CHECK (gross_amount > 0),
  CONSTRAINT airbnb_settlement_platform_fee_nonnegative CHECK (platform_fee >= 0),
  CONSTRAINT airbnb_settlement_expected_nonnegative CHECK (expected_payout >= 0),
  CONSTRAINT airbnb_settlement_actual_nonnegative CHECK (actual_receipt >= 0)
);

CREATE INDEX airbnb_settlement_org_reservation_created_idx
  ON airbnb_settlement (organization_id, reservation_id, created_at);

CREATE INDEX airbnb_settlement_org_property_created_idx
  ON airbnb_settlement (organization_id, property_id, created_at);

CREATE TABLE variance (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  property_id uuid REFERENCES property(id) ON DELETE RESTRICT,
  reservation_id uuid REFERENCES reservation(id) ON DELETE RESTRICT,
  expected_amount numeric(18, 2) NOT NULL,
  actual_amount numeric(18, 2) NOT NULL,
  variance_amount numeric(18, 2) NOT NULL,
  currency char(3) NOT NULL REFERENCES currency(code) ON DELETE RESTRICT,
  reason text NOT NULL,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  assigned_to uuid,
  resolved_by uuid,
  resolved_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT variance_status_check CHECK (status IN ('OPEN', 'RESOLVED', 'VOID')),
  CONSTRAINT variance_expected_nonnegative CHECK (expected_amount >= 0),
  CONSTRAINT variance_actual_nonnegative CHECK (actual_amount >= 0),
  CONSTRAINT variance_amount_positive CHECK (variance_amount > 0)
);

CREATE INDEX variance_org_status_created_idx
  ON variance (organization_id, status, created_at);

CREATE INDEX variance_org_source_idx
  ON variance (organization_id, source_type, source_id);

CREATE INDEX variance_org_property_status_idx
  ON variance (organization_id, property_id, status);

CREATE OR REPLACE FUNCTION app_assert_airbnb_settlement_organization_consistency()
RETURNS trigger AS $$
DECLARE
  reservation_org uuid;
  reservation_property uuid;
  property_org uuid;
BEGIN
  SELECT organization_id, property_id INTO reservation_org, reservation_property
  FROM reservation
  WHERE id = NEW.reservation_id;

  SELECT organization_id INTO property_org
  FROM property
  WHERE id = NEW.property_id;

  IF NEW.organization_id <> reservation_org
    OR NEW.organization_id <> property_org
    OR NEW.property_id <> reservation_property THEN
    RAISE EXCEPTION 'airbnb settlement organization mismatch';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER airbnb_settlement_organization_consistency
BEFORE INSERT OR UPDATE ON airbnb_settlement
FOR EACH ROW EXECUTE FUNCTION app_assert_airbnb_settlement_organization_consistency();

CREATE TRIGGER airbnb_settlement_no_update
BEFORE UPDATE ON airbnb_settlement
FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE TRIGGER airbnb_settlement_no_delete
BEFORE DELETE ON airbnb_settlement
FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE OR REPLACE FUNCTION app_assert_variance_organization_consistency()
RETURNS trigger AS $$
DECLARE
  property_org uuid;
  reservation_org uuid;
  reservation_property uuid;
BEGIN
  IF NEW.property_id IS NOT NULL THEN
    SELECT organization_id INTO property_org
    FROM property
    WHERE id = NEW.property_id;

    IF NEW.organization_id <> property_org THEN
      RAISE EXCEPTION 'variance property organization mismatch';
    END IF;
  END IF;

  IF NEW.reservation_id IS NOT NULL THEN
    SELECT organization_id, property_id INTO reservation_org, reservation_property
    FROM reservation
    WHERE id = NEW.reservation_id;

    IF NEW.organization_id <> reservation_org THEN
      RAISE EXCEPTION 'variance reservation organization mismatch';
    END IF;

    IF NEW.property_id IS NOT NULL AND NEW.property_id <> reservation_property THEN
      RAISE EXCEPTION 'variance property reservation mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER variance_organization_consistency
BEFORE INSERT OR UPDATE ON variance
FOR EACH ROW EXECUTE FUNCTION app_assert_variance_organization_consistency();

ALTER TABLE airbnb_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE airbnb_settlement FORCE ROW LEVEL SECURITY;
ALTER TABLE variance ENABLE ROW LEVEL SECURITY;
ALTER TABLE variance FORCE ROW LEVEL SECURITY;

CREATE POLICY airbnb_settlement_tenant_isolation ON airbnb_settlement
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY variance_tenant_isolation ON variance
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
