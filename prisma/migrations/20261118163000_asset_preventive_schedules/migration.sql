BEGIN;

CREATE FUNCTION app_guard_asset_preventive_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reference uuid;
BEGIN
  IF TG_OP='UPDATE' AND starts_with(OLD.series_key,'asset-preventive-') AND
    ROW(NEW.series_key,NEW.organization_id,NEW.property_id,NEW.type) IS DISTINCT FROM
    ROW(OLD.series_key,OLD.organization_id,OLD.property_id,OLD.type) THEN
    RAISE EXCEPTION 'preventive task asset and property are immutable';
  END IF;
  IF NOT coalesce(starts_with(NEW.series_key,'asset-preventive-'),false) THEN RETURN NEW; END IF;
  reference := substring(NEW.series_key FROM length('asset-preventive-')+1)::uuid;
  IF NEW.type <> 'MAINTENANCE' OR NOT EXISTS (
    SELECT 1 FROM asset WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND id=reference
  ) THEN RAISE EXCEPTION 'preventive task requires its canonical property asset'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER operation_task_asset_preventive_guard
BEFORE INSERT OR UPDATE OF series_key,organization_id,property_id,type ON operation_task
FOR EACH ROW EXECUTE FUNCTION app_guard_asset_preventive_task();

COMMIT;
