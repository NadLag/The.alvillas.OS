BEGIN;
CREATE FUNCTION app_admit_supplier_price_list() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE supplier_id uuid;
BEGIN
  supplier_id := substring(NEW.key FROM length('finance.supplier_price_list.')+1)::uuid;
  IF NEW.scope_type<>'organization' OR NEW.scope_id IS NOT NULL OR NEW.created_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM supplier s WHERE s.organization_id=NEW.organization_id AND s.id=supplier_id AND s.archived_at IS NULL
  ) THEN RAISE EXCEPTION 'price list requires an active tenant supplier'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER config_rule_admit_supplier_price_list BEFORE INSERT ON config_rule FOR EACH ROW
WHEN (starts_with(NEW.key, 'finance.supplier_price_list.')) EXECUTE FUNCTION app_admit_supplier_price_list();
COMMIT;
