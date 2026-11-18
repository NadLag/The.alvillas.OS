CREATE TABLE report_calendar_source_revision (
  organization_id uuid PRIMARY KEY REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  revision bigint NOT NULL CHECK (revision > 0)
);

CREATE TABLE report_calendar_materialization (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  period_key text NOT NULL CHECK (period_key IN ('CURRENT_MONTH','CURRENT_QUARTER','CURRENT_YEAR','PREVIOUS_MONTH')),
  from_on date NOT NULL,
  to_on date NOT NULL CHECK (to_on >= from_on),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  config_rule_id uuid NOT NULL,
  timezone text NOT NULL,
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id,period_key),
  FOREIGN KEY (organization_id,config_rule_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX report_calendar_materialization_range_idx ON report_calendar_materialization(organization_id,from_on,to_on);

ALTER TABLE report_calendar_source_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_calendar_source_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY report_calendar_source_revision_tenant_isolation ON report_calendar_source_revision
  USING (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);

ALTER TABLE report_calendar_materialization ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_calendar_materialization FORCE ROW LEVEL SECURITY;
CREATE POLICY report_calendar_materialization_tenant_isolation ON report_calendar_materialization
  USING (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);

-- The materialized calendar is disposable derived data. Source changes invalidate it atomically.
CREATE FUNCTION report_bump_calendar_source_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN tenant := OLD.organization_id;
  ELSE tenant := NEW.organization_id;
  END IF;
  INSERT INTO public.report_calendar_source_revision(organization_id,revision) VALUES(tenant,1)
  ON CONFLICT(organization_id) DO UPDATE SET revision = public.report_calendar_source_revision.revision + 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER report_property_calendar_changed AFTER INSERT OR DELETE OR UPDATE OF name,status,archived_at,timezone
  ON property FOR EACH ROW EXECUTE FUNCTION report_bump_calendar_source_revision();
CREATE TRIGGER report_reservation_calendar_changed AFTER INSERT OR DELETE OR UPDATE OF property_id,check_in,check_out,status,archived_at
  ON reservation FOR EACH ROW EXECUTE FUNCTION report_bump_calendar_source_revision();
CREATE TRIGGER report_calendar_block_changed AFTER INSERT OR DELETE OR UPDATE OF property_id,check_in,check_out,status,archived_at
  ON calendar_block FOR EACH ROW EXECUTE FUNCTION report_bump_calendar_source_revision();
