CREATE UNIQUE INDEX property_owner_one_active_primary_idx
  ON property_owner (organization_id, property_id)
  WHERE is_primary AND archived_at IS NULL;

CREATE INDEX property_owner_org_property_archived_share_idx
  ON property_owner (organization_id, property_id, archived_at, is_primary);

CREATE OR REPLACE FUNCTION app_assert_property_owner_organization_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  property_org uuid;
  owner_org uuid;
BEGIN
  SELECT organization_id INTO property_org
  FROM property
  WHERE id = NEW.property_id;

  SELECT organization_id INTO owner_org
  FROM owner
  WHERE id = NEW.owner_id;

  IF property_org IS DISTINCT FROM NEW.organization_id OR owner_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'property owner organization mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_assert_property_owner_share_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_organization_id uuid;
  checked_property_id uuid;
  active_count integer;
  primary_count integer;
  total_share_bps integer;
BEGIN
  checked_organization_id := COALESCE(NEW.organization_id, OLD.organization_id);
  checked_property_id := COALESCE(NEW.property_id, OLD.property_id);

  SELECT
    count(*),
    count(*) FILTER (WHERE is_primary),
    coalesce(sum(share_bps), 0)
    INTO active_count, primary_count, total_share_bps
  FROM property_owner
  WHERE organization_id = checked_organization_id
    AND property_id = checked_property_id
    AND archived_at IS NULL;

  IF active_count < 1 THEN
    RAISE EXCEPTION 'property must have at least one active owner';
  END IF;

  IF total_share_bps <> 10000 THEN
    RAISE EXCEPTION 'active property owner shares must total 10000 bps';
  END IF;

  IF primary_count <> 1 THEN
    RAISE EXCEPTION 'property must have exactly one primary owner';
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER property_owner_organization_consistency
BEFORE INSERT OR UPDATE ON property_owner
FOR EACH ROW EXECUTE FUNCTION app_assert_property_owner_organization_consistency();

CREATE TRIGGER property_owner_no_delete
BEFORE DELETE ON property_owner
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

CREATE CONSTRAINT TRIGGER property_owner_share_set_check
AFTER INSERT OR UPDATE OR DELETE ON property_owner
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_assert_property_owner_share_set();
