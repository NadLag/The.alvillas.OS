CREATE TABLE rate_limit_bucket (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  key_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  window_seconds integer NOT NULL,
  count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_limit_bucket_unique_window UNIQUE (
    organization_id,
    key_hash,
    window_start,
    window_seconds
  ),
  CONSTRAINT rate_limit_bucket_positive_window CHECK (window_seconds > 0),
  CONSTRAINT rate_limit_bucket_non_negative_count CHECK (count >= 0)
);

CREATE INDEX rate_limit_bucket_org_window_idx
  ON rate_limit_bucket (organization_id, window_start);

ALTER TABLE rate_limit_bucket ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_bucket FORCE ROW LEVEL SECURITY;

CREATE POLICY rate_limit_bucket_tenant_isolation ON rate_limit_bucket
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
