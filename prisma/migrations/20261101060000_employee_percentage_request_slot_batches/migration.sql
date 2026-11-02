BEGIN;
CREATE OR REPLACE FUNCTION public.app_employee_percentage_request_witness_birth()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
 DECLARE s employee_earning_request_work%ROWTYPE;q employee_earning_run_request%ROWTYPE;slot jsonb;journal_uuid uuid;
 BEGIN
 SELECT * INTO s FROM employee_earning_request_work WHERE organization_id=NEW.organization_id AND id=NEW.source_id;
 SELECT * INTO q FROM employee_earning_run_request WHERE organization_id=NEW.organization_id AND id=s.request_id;
 IF s.id IS NULL OR q.id IS NULL OR q.earning_kind<>'PERCENTAGE' OR s.evidence_id IS NOT NULL OR s.decision_id IS NOT NULL
  OR NEW.position<0
  OR EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=NEW.organization_id AND type='EmployeeEarningRunRequested' AND idempotency_key='employee-earning-run-request:'||q.id::text||':requested')
 THEN RAISE EXCEPTION 'percentage request witnesses require their original retained slot before the immutable worker receipt';END IF;
 SELECT transaction_id INTO journal_uuid FROM posting WHERE organization_id=NEW.organization_id AND id=NEW.posting_id;
 IF journal_uuid IS NULL THEN RAISE EXCEPTION 'percentage original journal is unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':journal-reversal:'||journal_uuid::text,0));
 NEW.created_at=clock_timestamp();RETURN NEW;
 END $function$;
CREATE FUNCTION app_employee_percentage_request_witness_slots() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
 BEGIN
 IF EXISTS(
  WITH selected_sources AS MATERIALIZED(SELECT DISTINCT organization_id,source_id FROM inserted_percentage_witnesses),
  original_slots AS MATERIALIZED(
   SELECT s.organization_id,s.id source_id,slot.value,slot.ordinality-1 position
   FROM employee_earning_request_work s JOIN selected_sources selected ON selected.organization_id=s.organization_id AND selected.source_id=s.id
   CROSS JOIN LATERAL jsonb_array_elements(s.source_snapshot->'witnesses') WITH ORDINALITY slot(value,ordinality)
  )
  SELECT 1 FROM inserted_percentage_witnesses w LEFT JOIN original_slots slot ON slot.organization_id=w.organization_id AND slot.source_id=w.source_id AND slot.position=w.position
  WHERE slot.value IS NULL OR slot.value->>'postingId' IS DISTINCT FROM w.posting_id::text
   OR slot.value->>'compensationId' IS DISTINCT FROM w.compensation_id::text OR slot.value->>'configRuleId' IS DISTINCT FROM w.config_rule_id::text
   OR(slot.value->>'isEarningBase')::boolean IS DISTINCT FROM w.is_earning_base
 ) THEN RAISE EXCEPTION 'percentage request witness differs from its original retained slot';END IF;
 RETURN NULL;
 END $$;
 CREATE TRIGGER employee_earning_percentage_witness_slots AFTER INSERT ON employee_earning_request_percentage_witness
 REFERENCING NEW TABLE AS inserted_percentage_witnesses FOR EACH STATEMENT EXECUTE FUNCTION app_employee_percentage_request_witness_slots();
 
COMMIT;
