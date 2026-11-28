-- Keep the established tenant-isolation policy names without changing access.
DROP POLICY laundry_batch_tenant ON laundry_batch;
CREATE POLICY laundry_batch_tenant_isolation ON laundry_batch USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY laundry_batch_line_tenant ON laundry_batch_line;
CREATE POLICY laundry_batch_line_tenant_isolation ON laundry_batch_line USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY laundry_batch_event_tenant ON laundry_batch_event;
CREATE POLICY laundry_batch_event_tenant_isolation ON laundry_batch_event USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
DROP POLICY laundry_batch_change_tenant ON laundry_batch_change;
CREATE POLICY laundry_batch_change_tenant_isolation ON laundry_batch_change USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

CREATE FUNCTION app_laundry_original_command_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF NEW.observed_at>NEW.created_at OR (NEW.command->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at OR jsonb_typeof(NEW.command->'changes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'laundry_original_observation_required';END IF;
 SELECT count(*) INTO n FROM laundry_batch_change WHERE organization_id=NEW.organization_id AND event_id=NEW.id;
 IF NEW.operation IN('REVERSE','CLOSE','CANCEL') THEN
  IF jsonb_array_length(NEW.command->'changes')<>0 THEN RAISE EXCEPTION 'laundry_original_command_changes_required';END IF;
 ELSE
  IF n<>jsonb_array_length(NEW.command->'changes') OR EXISTS(SELECT 1 FROM laundry_batch_change c WHERE c.organization_id=NEW.organization_id AND c.event_id=NEW.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.command->'changes') entry WHERE entry->>'lineId'=c.line_id::text AND entry->>'from'=c.from_bucket AND entry->>'quantity'=c.quantity::text)) THEN RAISE EXCEPTION 'laundry_original_command_changes_required';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM laundry_batch_change c WHERE c.organization_id=NEW.organization_id AND c.event_id=NEW.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'changes') entry WHERE entry->>'id'=c.id::text AND entry->>'reversesChangeId' IS NOT DISTINCT FROM c.reverses_change_id::text)) THEN RAISE EXCEPTION 'laundry_original_command_reversal_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER laundry_original_command_complete AFTER INSERT ON laundry_batch_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_laundry_original_command_complete();
