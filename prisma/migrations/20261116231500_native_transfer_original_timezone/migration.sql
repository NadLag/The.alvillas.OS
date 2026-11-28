-- Admit only an actual original property timezone for new transfer requests.
-- Retain every historical source witness without fabricated backfills.
CREATE FUNCTION app_guard_transfer_timezone_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.catalog_snapshot#>'{order_terms,transfer_order}' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM property p WHERE p.organization_id=NEW.organization_id AND p.id=NEW.property_id AND NEW.source_witnesses#>>'{property,timezone}'=p.timezone)
 THEN RAISE EXCEPTION 'transfer_original_property_timezone_required';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transfer_timezone_birth_guard BEFORE INSERT ON service_order FOR EACH ROW EXECUTE FUNCTION app_guard_transfer_timezone_birth();
