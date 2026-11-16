-- Actual completed work may arrive before its earlier order progress notification.
-- Preserve migration261 and retain all actual completion checks in this forward definition.
CREATE OR REPLACE FUNCTION app_guard_service_order() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source config_rule%ROWTYPE;policy config_rule%ROWTYPE;entry jsonb;money_precision integer;expected_total numeric;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'service_order_history_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.state<>'REQUESTED' OR NEW.quote_reference IS NOT NULL OR NEW.task_id IS NOT NULL
   OR NEW.created_at<>NEW.updated_at OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp()
   OR NOT EXISTS(SELECT 1 FROM reservation r JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id
    JOIN user_account u ON u.organization_id=r.organization_id AND u.id=NEW.created_by
    WHERE r.organization_id=NEW.organization_id AND r.id=NEW.reservation_id AND r.property_id=NEW.property_id
     AND r.archived_at IS NULL AND p.archived_at IS NULL AND u.status='ACTIVE' AND r.status NOT IN('CANCELLED','NO_SHOW','CLOSED')
     AND NEW.service_date>=r.check_in AND NEW.last_service_date<=r.check_out AND NEW.guest_count<=r.adult_count+r.child_count)
   OR NEW.request_snapshot->>'propertyId' IS DISTINCT FROM NEW.property_id::text
   OR NEW.request_snapshot->>'reservationId' IS DISTINCT FROM NEW.reservation_id::text
   OR NEW.request_snapshot->>'serviceKey' IS DISTINCT FROM NEW.service_key
   OR NEW.request_snapshot->>'serviceDate' IS DISTINCT FROM NEW.service_date::text
   OR NEW.request_snapshot->>'lastServiceDate' IS DISTINCT FROM NEW.last_service_date::text
   OR NEW.request_snapshot->>'quantity' IS DISTINCT FROM NEW.quantity::text
   OR NEW.request_snapshot->>'guests' IS DISTINCT FROM NEW.guest_count::text
  THEN RAISE EXCEPTION 'service_order_native_request_required'; END IF;
  SELECT * INTO source FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.catalog_rule_id;
  SELECT item INTO entry FROM jsonb_array_elements(source.value->'services') item WHERE item->>'key'=NEW.service_key;
  IF source.key IS DISTINCT FROM 'services.pricing' OR source.version IS DISTINCT FROM NEW.catalog_rule_version
   OR source.archived_at IS NOT NULL OR source.created_by IS NULL OR source.lifecycle NOT IN('ACTIVE','RETIRED')
   OR source.effective_from>NEW.created_at OR source.effective_to<=NEW.created_at
   OR entry IS NULL OR entry->>'available' IS DISTINCT FROM 'true' OR jsonb_typeof(entry->'order_terms') IS DISTINCT FROM 'object'
   OR NEW.catalog_snapshot IS DISTINCT FROM(SELECT jsonb_object_agg(k,v) FROM jsonb_each(entry) fields(k,v)
     WHERE k IN('key','name','description','available','pricing_model','amount','currency','order_terms'))
   OR NEW.currency IS DISTINCT FROM entry->>'currency'
   OR NEW.title_translations IS DISTINCT FROM entry->'name'
   OR (entry->>'pricing_model'='CUSTOM') IS DISTINCT FROM (NEW.total_amount IS NULL)
  THEN RAISE EXCEPTION 'service_order_original_catalog_required'; END IF;
  SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=(NEW.source_witnesses#>>'{policyRule,id}')::uuid;
  IF NOT coalesce(policy.key='services.ordering' AND policy.version=(NEW.source_witnesses#>>'{policyRule,version}')::integer
   AND policy.archived_at IS NULL AND policy.created_by IS NOT NULL AND policy.lifecycle IN('ACTIVE','RETIRED')
   AND policy.effective_from<=NEW.created_at AND(policy.effective_to IS NULL OR policy.effective_to>NEW.created_at)
   AND policy.value->>'schemaVersion'='1' AND policy.value->>'participant_basis'='SELECTED_RESERVATION_GUESTS'
   AND policy.value->>'date_basis'='INCLUSIVE_RESERVATION_DATES'
   AND NEW.quantity<=(policy.value->>'max_quantity')::bigint
   AND NEW.last_service_date-NEW.service_date+1<=(policy.value->>'max_service_days')::bigint,false)
  THEN RAISE EXCEPTION 'service_order_configured_request_limits_required'; END IF;
  IF entry->>'pricing_model'<>'CUSTOM' THEN
   expected_total=(entry->>'amount')::numeric*NEW.quantity*CASE entry->>'pricing_model'
    WHEN 'PER_GUEST' THEN NEW.guest_count WHEN 'PER_DAY' THEN NEW.last_service_date-NEW.service_date+1 ELSE 1 END;
   IF NEW.total_amount IS DISTINCT FROM expected_total THEN RAISE EXCEPTION 'service_order_exact_catalog_total_required'; END IF;
  END IF;
 ELSE
  IF ROW(OLD.id,OLD.organization_id,OLD.property_id,OLD.reservation_id,OLD.catalog_rule_id,OLD.catalog_rule_version,
    OLD.service_key,OLD.title_translations,OLD.service_date,OLD.last_service_date,OLD.quantity,OLD.guest_count,
    OLD.request_snapshot,OLD.catalog_snapshot,OLD.source_witnesses,OLD.currency,OLD.created_by,OLD.created_at)
   IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.property_id,NEW.reservation_id,NEW.catalog_rule_id,NEW.catalog_rule_version,
    NEW.service_key,NEW.title_translations,NEW.service_date,NEW.last_service_date,NEW.quantity,NEW.guest_count,
    NEW.request_snapshot,NEW.catalog_snapshot,NEW.source_witnesses,NEW.currency,NEW.created_by,NEW.created_at)
   OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR NEW.updated_at>clock_timestamp()
   OR NOT((OLD.state='REQUESTED' AND NEW.state IN('QUOTED','CONFIRMED','REJECTED','CANCELLED'))
    OR(OLD.state='QUOTED' AND NEW.state IN('QUOTED','CONFIRMED','REJECTED','CANCELLED'))
    OR(OLD.state='CONFIRMED' AND NEW.state IN('IN_PROGRESS','FULFILLED','CANCELLED'))
    OR(OLD.state='IN_PROGRESS' AND NEW.state IN('FULFILLED','CANCELLED')))
  THEN RAISE EXCEPTION 'service_order_original_or_transition_immutable'; END IF;
  IF NEW.state='QUOTED' THEN
   IF NEW.catalog_snapshot->>'pricing_model'<>'CUSTOM' OR NEW.total_amount IS NULL OR NEW.quote_reference IS NULL OR length(btrim(NEW.quote_reference)) NOT BETWEEN 1 AND 240
   THEN RAISE EXCEPTION 'service_order_explicit_quote_required'; END IF;
  ELSIF ROW(OLD.total_amount,OLD.quote_reference) IS DISTINCT FROM ROW(NEW.total_amount,NEW.quote_reference)
   THEN RAISE EXCEPTION 'service_order_original_price_immutable';
  END IF;
  IF OLD.task_id IS DISTINCT FROM NEW.task_id AND (OLD.task_id IS NOT NULL OR NEW.state<>'CONFIRMED' OR NOT EXISTS(
   SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id AND t.id=NEW.task_id
    AND t.property_id=NEW.property_id AND t.reservation_id=NEW.reservation_id AND t.archived_at IS NULL
    AND t.xmin::text=pg_current_xact_id()::xid::text))
  THEN RAISE EXCEPTION 'service_order_native_task_required'; END IF;
  IF NEW.state IN('CONFIRMED','IN_PROGRESS','FULFILLED') AND NEW.total_amount IS NULL
  THEN RAISE EXCEPTION 'service_order_accepted_total_required'; END IF;
 END IF;
 SELECT minor_unit INTO money_precision FROM currency WHERE code=NEW.currency;
 IF money_precision IS NULL OR money_precision NOT BETWEEN 0 AND 2 OR NEW.total_amount<>round(NEW.total_amount,money_precision)
 THEN RAISE EXCEPTION 'service_order_registered_currency_required'; END IF;
 IF NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id
  AND t.id=NEW.task_id AND t.property_id=NEW.property_id AND t.reservation_id=NEW.reservation_id)
 THEN RAISE EXCEPTION 'service_order_task_scope_mismatch'; END IF;
 IF NEW.state IN('IN_PROGRESS','FULFILLED') AND NOT EXISTS(SELECT 1 FROM operation_task t
  WHERE t.organization_id=NEW.organization_id AND t.id=NEW.task_id AND t.archived_at IS NULL
   AND t.state=CASE WHEN NEW.state='IN_PROGRESS' THEN 'IN_PROGRESS' ELSE 'COMPLETED' END
   AND EXISTS(SELECT 1 FROM operation_task_event e WHERE e.organization_id=t.organization_id AND e.task_id=t.id
    AND e.kind='CHANGED' AND e.version<=t.version AND e.after->>'state'=t.state AND e.before->>'state' IS DISTINCT FROM t.state)
   AND(NEW.state<>'FULFILLED' OR(t.completed_at IS NOT NULL AND t.completed_by_person_id IS NOT NULL AND t.completion_idempotency_key IS NOT NULL)))
 THEN RAISE EXCEPTION 'service_order_actual_work_required'; END IF;
 IF NEW.state='CANCELLED' AND EXISTS(SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id AND t.id=NEW.task_id AND t.state='COMPLETED')
 THEN RAISE EXCEPTION 'service_order_completed_work_cannot_be_cancelled'; END IF;
 RETURN NEW;
END $$;

-- Forward-only fulfillment admission. Migration261 and its original history
-- remain unchanged after their local application.
CREATE FUNCTION app_guard_service_order_fulfillment_task() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.state='CONFIRMED' AND NEW.task_id IS NULL THEN
  RAISE EXCEPTION 'service_order_confirmed_native_task_required';
 END IF;
 IF NEW.state='CANCELLED' AND NEW.task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id AND t.id=NEW.task_id
   AND t.property_id=NEW.property_id AND t.reservation_id=NEW.reservation_id AND t.state='CANCELLED')
 THEN RAISE EXCEPTION 'service_order_native_task_cancellation_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_order_fulfillment_task_guard BEFORE UPDATE ON service_order
 FOR EACH ROW EXECUTE FUNCTION app_guard_service_order_fulfillment_task();

CREATE FUNCTION app_service_order_confirmation_task_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.to_state='CONFIRMED' AND NOT EXISTS(
  SELECT 1 FROM service_order r JOIN operation_task t ON t.organization_id=r.organization_id AND t.id=r.task_id
  WHERE r.organization_id=NEW.organization_id AND r.id=NEW.order_id AND r.version=NEW.version
   AND t.property_id=r.property_id AND t.reservation_id=r.reservation_id AND t.created_by=NEW.created_by
   AND t.archived_at IS NULL AND t.xmin::text=pg_current_xact_id()::xid::text
   AND EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=t.organization_id AND a.resource_type='task'
    AND a.resource_id=t.id AND a.actor_id=NEW.created_by AND a.action='task.create'
    AND a.property_scope_id=t.property_id AND a.xmin::text=pg_current_xact_id()::xid::text))
 THEN RAISE EXCEPTION 'service_order_actual_confirmation_task_required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_order_confirmation_task_guard AFTER INSERT ON service_order_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_service_order_confirmation_task_complete();
