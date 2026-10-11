CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION app_uuid_v7()
RETURNS uuid AS $$
DECLARE
  unix_ms bigint;
  rand bytea;
  bytes bytea;
BEGIN
  unix_ms := floor(extract(epoch FROM clock_timestamp()) * 1000);
  rand := gen_random_bytes(10);
  bytes :=
    set_byte(
      set_byte(
        decode(lpad(to_hex(unix_ms), 12, '0'), 'hex') || rand,
        6,
        (get_byte(rand, 0) & 15) | 112
      ),
      8,
      (get_byte(rand, 2) & 63) | 128
    );

  RETURN encode(bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TABLE organization (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  name text NOT NULL,
  base_currency char(3) NOT NULL DEFAULT 'MAD',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE currency (
  code char(3) PRIMARY KEY,
  name text NOT NULL,
  minor_unit integer NOT NULL DEFAULT 2,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE config_rule (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  key text NOT NULL,
  scope_type text NOT NULL,
  scope_id uuid,
  value jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  version integer NOT NULL,
  created_by uuid,
  reason text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX config_rule_org_key_scope_effective_idx
  ON config_rule (organization_id, key, scope_type, effective_from);

CREATE TABLE outbox_event (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_event_org_idempotency_key UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX outbox_event_org_status_occurred_idx
  ON outbox_event (organization_id, status, occurred_at);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  ip_address text,
  device_id text,
  property_scope_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  request_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_org_occurred_idx
  ON audit_log (organization_id, occurred_at);

CREATE INDEX audit_log_org_resource_idx
  ON audit_log (organization_id, resource_type, resource_id);

CREATE OR REPLACE FUNCTION app_prevent_audit_log_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
FOR EACH ROW EXECUTE FUNCTION app_prevent_audit_log_mutation();

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION app_prevent_audit_log_mutation();

ALTER TABLE config_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY config_rule_tenant_isolation ON config_rule
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY outbox_event_tenant_isolation ON outbox_event
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

INSERT INTO currency (code, name, minor_unit)
VALUES
  ('MAD', 'Moroccan dirham', 2),
  ('EUR', 'Euro', 2),
  ('USD', 'United States dollar', 2)
ON CONFLICT (code) DO NOTHING;
