CREATE TABLE report_run (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  config_rule_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  property_id uuid,
  report_kind text NOT NULL CHECK (report_kind IN ('PROPERTY','COMPANY','TEAM','INVENTORY','KPI')),
  scheduled_on date NOT NULL,
  from_on date NOT NULL,
  to_on date NOT NULL CHECK (to_on>=from_on),
  currency character(3) NOT NULL REFERENCES currency(code) ON DELETE RESTRICT,
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object'),
  channels text[] NOT NULL CHECK (cardinality(channels)>0 AND channels <@ ARRAY['in_app','email','push']::text[]),
  source_fingerprint char(64) NOT NULL,
  generated_at timestamptz NOT NULL,
  CONSTRAINT report_run_schedule_occurrence_key UNIQUE (organization_id,schedule_id,recipient_id,scheduled_on),
  FOREIGN KEY (organization_id,config_rule_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,recipient_id) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,property_id) REFERENCES property(organization_id,id) ON DELETE RESTRICT
);
CREATE INDEX report_run_recipient_idx ON report_run(organization_id,recipient_id,generated_at DESC);

ALTER TABLE report_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_run FORCE ROW LEVEL SECURITY;
CREATE POLICY report_run_tenant_isolation ON report_run
  USING (organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION enforce_report_run_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'Scheduled report receipts are append only';
END;
$$;
CREATE TRIGGER report_run_immutable BEFORE UPDATE OR DELETE ON report_run FOR EACH ROW
  EXECUTE FUNCTION enforce_report_run_immutable();

DO $$
DECLARE previous_expression text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_expression FROM pg_constraint
    WHERE conname='notification_kind_check' AND conrelid='notification'::regclass;
  ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
  EXECUTE format('ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK ((%s) OR kind=%L)',previous_expression,'report_ready');
END;
$$;
