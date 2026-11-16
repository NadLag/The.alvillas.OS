-- Canonical orders retain their original service/currency identity while
-- existing financial sources retain their exact collection/cost/journal chains.
-- No prior financial row is rewritten and no money movement is manufactured.
CREATE FUNCTION app_assert_service_order_allocation(
 org_id uuid, financial_source_id uuid, decision jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE subject record;
BEGIN
 SELECT o.id,o.task_id,o.property_id,o.reservation_id,o.service_key,o.currency,o.state
 INTO subject
 FROM service_financial_source source
 JOIN cash_collection collection ON collection.organization_id=source.organization_id
  AND collection.id=source.cash_collection_id
 JOIN service_order o ON o.organization_id=collection.organization_id
  AND o.task_id=collection.task_id
 WHERE source.organization_id=org_id AND source.id=financial_source_id
 FOR KEY SHARE OF o;
 IF NOT FOUND THEN RETURN; END IF;
 IF subject.state NOT IN ('CONFIRMED','IN_PROGRESS','FULFILLED')
  OR decision->'recipe'->>'service_key' IS DISTINCT FROM subject.service_key
  OR decision->'source'->>'taskId' IS DISTINCT FROM subject.task_id::text
  OR decision->'source'->>'propertyId' IS DISTINCT FROM subject.property_id::text
  OR decision->'source'->>'reservationId' IS DISTINCT FROM subject.reservation_id::text
  OR decision->'source'->'amount'->>'currency' IS DISTINCT FROM subject.currency
 THEN RAISE EXCEPTION 'service financial decision requires its canonical native order identity';
 END IF;
END;
$$;

CREATE FUNCTION app_service_order_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app_assert_service_order_allocation(NEW.organization_id,NEW.source_id,NEW.snapshot);
 RETURN NEW;
END;
$$;
CREATE TRIGGER service_order_financial_admission_guard BEFORE INSERT ON service_allocation_admission
 FOR EACH ROW EXECUTE FUNCTION app_service_order_admission_guard();

CREATE FUNCTION app_service_order_posting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision jsonb;
BEGIN
 -- A correction must remain able to reverse an original financial decision.
 -- Its existing native reversal guards still require the exact sealed opposite.
 IF NEW.kind='RECOGNITION' THEN
  SELECT snapshot INTO decision FROM service_allocation_admission
  WHERE organization_id=NEW.organization_id AND id=NEW.admission_id AND source_id=NEW.source_id;
  IF FOUND THEN
   PERFORM app_assert_service_order_allocation(NEW.organization_id,NEW.source_id,decision);
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER service_order_financial_posting_guard BEFORE INSERT ON service_allocation_posting
 FOR EACH ROW EXECUTE FUNCTION app_service_order_posting_guard();
