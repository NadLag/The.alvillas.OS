-- Recipe definitions remain in the existing versioned service catalog and
-- original order snapshot. Guard new work/financial admissions; rewrite no row.
CREATE FUNCTION app_assert_native_chef_work(org_id uuid, task_id uuid, catalog jsonb, require_completion boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE menu jsonb; chef_id uuid; work record;
BEGIN
 menu=catalog#>'{order_terms,chef_menu}';
 IF menu IS NULL THEN RETURN; END IF;
 IF jsonb_typeof(menu) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'chef_menu_original_definition_required'; END IF;
 SELECT (provider->>'id')::uuid INTO STRICT chef_id
 FROM jsonb_array_elements(catalog#>'{order_terms,providers}') provider
 WHERE provider->>'component_key'=menu->>'chef_component_key' AND provider->>'kind'='PERSON';
 IF NOT EXISTS(SELECT 1 FROM person WHERE organization_id=org_id AND id=chef_id)
 THEN RAISE EXCEPTION 'chef_menu_actual_tenant_person_required'; END IF;
 IF task_id IS NULL THEN
  IF require_completion THEN RAISE EXCEPTION 'chef_menu_actual_completed_work_required'; END IF;
  RETURN;
 END IF;
 SELECT type,state,completed_by_person_id INTO work FROM operation_task
 WHERE organization_id=org_id AND id=task_id;
 IF NOT FOUND OR work.type<>'CHEF' THEN RAISE EXCEPTION 'chef_menu_native_cooking_task_required'; END IF;
 IF require_completion AND(work.state<>'COMPLETED' OR work.completed_by_person_id IS DISTINCT FROM chef_id)
 THEN RAISE EXCEPTION 'chef_menu_original_performer_required'; END IF;
END;
$$;

CREATE FUNCTION app_chef_order_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app_assert_native_chef_work(NEW.organization_id,NEW.task_id,NEW.catalog_snapshot,NEW.state='FULFILLED');
 RETURN NEW;
END;
$$;
CREATE TRIGGER chef_order_work_guard BEFORE INSERT OR UPDATE ON service_order
 FOR EACH ROW EXECUTE FUNCTION app_chef_order_work_guard();

-- Retain every existing identity/currency/state check and its row lock. The
-- existing admission and RECOGNITION triggers already call this function;
-- their sealed reversal path remains independent of current chef availability.
CREATE OR REPLACE FUNCTION app_assert_service_order_allocation(org_id uuid, financial_source_id uuid, decision jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE subject record;
BEGIN
 SELECT o.id,o.task_id,o.property_id,o.reservation_id,o.service_key,o.currency,o.state,o.catalog_snapshot
 INTO subject FROM service_financial_source source
 JOIN cash_collection collection ON collection.organization_id=source.organization_id AND collection.id=source.cash_collection_id
 JOIN service_order o ON o.organization_id=collection.organization_id AND o.task_id=collection.task_id
 WHERE source.organization_id=org_id AND source.id=financial_source_id FOR KEY SHARE OF o;
 IF NOT FOUND THEN RETURN; END IF;
 IF subject.state NOT IN ('CONFIRMED','IN_PROGRESS','FULFILLED')
  OR decision->'recipe'->>'service_key' IS DISTINCT FROM subject.service_key
  OR decision->'source'->>'taskId' IS DISTINCT FROM subject.task_id::text
  OR decision->'source'->>'propertyId' IS DISTINCT FROM subject.property_id::text
  OR decision->'source'->>'reservationId' IS DISTINCT FROM subject.reservation_id::text
  OR decision->'source'->'amount'->>'currency' IS DISTINCT FROM subject.currency
 THEN RAISE EXCEPTION 'service financial decision requires its canonical native order identity'; END IF;
 PERFORM app_assert_native_chef_work(org_id,subject.task_id,subject.catalog_snapshot,true);
END;
$$;
