CREATE TABLE exchange_rate (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  from_currency char(3) NOT NULL REFERENCES currency(code) ON DELETE RESTRICT,
  to_currency char(3) NOT NULL REFERENCES currency(code) ON DELETE RESTRICT,
  rate numeric(18, 8) NOT NULL,
  source text NOT NULL,
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_rate_positive_rate CHECK (rate > 0),
  CONSTRAINT exchange_rate_distinct_currency CHECK (from_currency <> to_currency)
);

CREATE INDEX exchange_rate_org_pair_effective_idx
  ON exchange_rate (organization_id, from_currency, to_currency, effective_at);

ALTER TABLE exchange_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rate FORCE ROW LEVEL SECURITY;

CREATE POLICY exchange_rate_tenant_isolation ON exchange_rate
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
