-- Transfers reuse native orders, assignments, work and cash custody. No
-- financial data, original snapshots or applied migrations are rewritten.
CREATE FUNCTION app_guard_native_transfer_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terms jsonb; request jsonb; field text;
BEGIN
 terms:=NEW.catalog_snapshot#>'{order_terms,transfer_order}';request:=NEW.request_snapshot->'transfer';
 IF (terms IS NOT NULL) IS DISTINCT FROM (request IS NOT NULL) THEN RAISE EXCEPTION 'transfer_original_request_required';END IF;
 IF terms IS NOT NULL THEN
  IF jsonb_typeof(terms)<>'object' OR terms<>jsonb_build_object('schemaVersion',1,'task_type','TRANSFER','cash','NATIVE_CASH_CUSTODY')
   OR NEW.catalog_snapshot#>'{order_terms,chef_menu}' IS NOT NULL OR NEW.catalog_snapshot#>'{order_terms,grocery_order}' IS NOT NULL
   OR jsonb_typeof(request)<>'object' OR NEW.service_date<>NEW.last_service_date
   OR NOT COALESCE(request->>'pickupTime'~'^([01][0-9]|2[0-3]):[0-5][0-9]$',false)
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(request) k WHERE k NOT IN('pickup','destination','pickupTime','flightReference','instructions'))
  THEN RAISE EXCEPTION 'transfer_original_request_invalid';END IF;
  FOREACH field IN ARRAY ARRAY['pickup','destination'] LOOP
   IF NOT COALESCE(jsonb_typeof(request->field)='string' AND length(btrim(request->>field)) BETWEEN 1 AND 500,false) THEN RAISE EXCEPTION 'transfer_original_locations_required';END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['flightReference','instructions'] LOOP
   IF request?field AND NOT COALESCE(jsonb_typeof(request->field)='string' AND length(btrim(request->>field)) BETWEEN 1 AND CASE WHEN field='flightReference' THEN 100 ELSE 500 END,false) THEN RAISE EXCEPTION 'transfer_original_instructions_invalid';END IF;
  END LOOP;
  IF NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id AND t.id=NEW.task_id AND t.type='TRANSFER') THEN RAISE EXCEPTION 'transfer_native_task_required';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_transfer_request_guard BEFORE INSERT OR UPDATE ON service_order FOR EACH ROW EXECUTE FUNCTION app_guard_native_transfer_request();
CREATE FUNCTION app_guard_native_transfer_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.type<>'TRANSFER' AND EXISTS(SELECT 1 FROM service_order o WHERE o.organization_id=NEW.organization_id AND o.task_id=NEW.id AND o.catalog_snapshot#>'{order_terms,transfer_order}' IS NOT NULL)
 THEN RAISE EXCEPTION 'transfer_original_task_type_required';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_transfer_task_guard BEFORE UPDATE OF type ON operation_task FOR EACH ROW EXECUTE FUNCTION app_guard_native_transfer_task();
