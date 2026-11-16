-- New chef admissions must use the actual selected chef's independently
-- recognized employee cost. Existing journal and reversal guards are retained.
CREATE FUNCTION app_assert_native_chef_cost_party(org_id uuid, financial_source_id uuid, decision jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE catalog jsonb; menu jsonb; chef_id text;
BEGIN
 SELECT o.catalog_snapshot INTO catalog FROM service_financial_source source
 JOIN cash_collection collection ON collection.organization_id=source.organization_id AND collection.id=source.cash_collection_id
 JOIN service_order o ON o.organization_id=collection.organization_id AND o.task_id=collection.task_id
 WHERE source.organization_id=org_id AND source.id=financial_source_id FOR KEY SHARE OF o;
 IF NOT FOUND THEN RETURN; END IF;
 menu=catalog#>'{order_terms,chef_menu}';IF menu IS NULL THEN RETURN; END IF;
 SELECT provider->>'id' INTO STRICT chef_id FROM jsonb_array_elements(catalog#>'{order_terms,providers}') provider
 WHERE provider->>'component_key'=menu->>'chef_component_key' AND provider->>'kind'='PERSON';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(decision->'providerCosts') cost
  WHERE cost->>'componentKey'=menu->>'chef_component_key'
   AND(cost->>'sourceKind' IS DISTINCT FROM 'EMPLOYEE_COST' OR lower(cost->>'partyId') IS DISTINCT FROM lower(chef_id)))
 THEN RAISE EXCEPTION 'chef_menu_original_cost_party_required'; END IF;
END;
$$;
CREATE FUNCTION app_chef_cost_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app_assert_native_chef_cost_party(NEW.organization_id,NEW.source_id,NEW.snapshot);RETURN NEW;
END;
$$;
CREATE TRIGGER chef_cost_admission_guard BEFORE INSERT ON service_allocation_admission
 FOR EACH ROW EXECUTE FUNCTION app_chef_cost_admission_guard();
CREATE FUNCTION app_chef_cost_posting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision jsonb;
BEGIN
 IF NEW.kind='RECOGNITION' THEN
  SELECT snapshot INTO decision FROM service_allocation_admission
  WHERE organization_id=NEW.organization_id AND id=NEW.admission_id AND source_id=NEW.source_id;
  IF FOUND THEN PERFORM app_assert_native_chef_cost_party(NEW.organization_id,NEW.source_id,decision);END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER chef_cost_posting_guard BEFORE INSERT ON service_allocation_posting
 FOR EACH ROW EXECUTE FUNCTION app_chef_cost_posting_guard();
