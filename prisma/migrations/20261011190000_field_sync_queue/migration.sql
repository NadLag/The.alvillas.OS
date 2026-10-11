ALTER TABLE operation_task
  ADD COLUMN completion_idempotency_key uuid;

CREATE UNIQUE INDEX operation_task_org_completion_idempotency_unique
  ON operation_task (organization_id, completion_idempotency_key);

CREATE TABLE sync_op (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  device_id text NOT NULL,
  client_op_id uuid NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  result jsonb,
  error_code text,
  actor_user_account_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
  actor_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  client_created_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_op_status_check CHECK (status IN ('PENDING', 'APPLIED', 'DUPLICATE', 'CONFLICT', 'REJECTED')),
  CONSTRAINT sync_op_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT sync_op_result_check CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);

CREATE UNIQUE INDEX sync_op_org_device_client_unique
  ON sync_op (organization_id, device_id, client_op_id);

CREATE INDEX sync_op_org_status_created_idx
  ON sync_op (organization_id, status, created_at);

ALTER TABLE sync_op ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_op FORCE ROW LEVEL SECURITY;

CREATE POLICY sync_op_tenant_isolation ON sync_op
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
