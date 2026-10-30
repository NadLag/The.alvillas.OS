BEGIN;

-- Extend the shared stage admission guard for the actual employee source.
CREATE OR REPLACE FUNCTION app_financial_approval_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'financial approval stages cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'PENDING' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_reason IS NOT NULL THEN RAISE EXCEPTION 'approval stages start pending'; END IF;
  IF NOT EXISTS (SELECT 1 FROM approval_request a JOIN expense e ON e.organization_id=a.organization_id AND e.id=a.expense_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND e.state='PENDING_APPROVAL' AND e.currency=NEW.currency)
  AND NOT EXISTS (SELECT 1 FROM approval_request a
    JOIN supplier_invoice_submission s ON s.organization_id=a.organization_id AND s.id=a.invoice_submission_id
    JOIN supplier_invoice i ON i.organization_id=s.organization_id AND i.id=s.invoice_id AND i.current_submission_id=s.id AND i.current_revision_id=s.revision_id
    JOIN supplier_invoice_revision r ON r.organization_id=s.organization_id AND r.id=s.revision_id AND r.invoice_id=i.id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND i.state='PENDING_APPROVAL' AND r.currency=NEW.currency)
  AND NOT EXISTS(SELECT 1 FROM approval_request a JOIN employee_compensation_submission s ON s.organization_id=a.organization_id AND s.id=a.employee_submission_id
    JOIN employee_compensation_run r ON r.organization_id=s.organization_id AND r.id=s.run_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND a.state='PENDING' AND r.currency=NEW.currency
    AND NOT EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=s.organization_id AND w.submission_id=s.id))
  THEN RAISE EXCEPTION 'financial approval stage requires its actual submitted expense, invoice or employee work'; END IF;
 ELSE
  IF ROW(NEW.organization_id,NEW.id,NEW.approval_id,NEW.position,NEW.kind,NEW.owner_id,NEW.amount,NEW.currency,NEW.routing_snapshot)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.approval_id,OLD.position,OLD.kind,OLD.owner_id,OLD.amount,OLD.currency,OLD.routing_snapshot)
   OR OLD.state<>'PENDING' OR NEW.state NOT IN ('APPROVED','REJECTED','CANCELLED')
   OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR NEW.decision_reason IS NULL OR length(trim(NEW.decision_reason))<6
  THEN RAISE EXCEPTION 'financial approval decisions are immutable and require attribution'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app_employee_review_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a approval_request%ROWTYPE; source_id uuid; approval_id uuid; folded text; stage approval_stage%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='approval_request' THEN approval_id=NEW.id;ELSE approval_id=NEW.approval_id;END IF;
 SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=approval_id;
 IF a.employee_submission_id IS NULL THEN RETURN NEW;END IF;source_id=a.employee_submission_id;
 SELECT CASE WHEN count(*) FILTER(WHERE state='REJECTED')>0 THEN 'REJECTED'
  WHEN count(*)>0 AND count(*)=count(*) FILTER(WHERE state='APPROVED') THEN 'APPROVED' ELSE 'PENDING' END
  INTO folded FROM approval_stage WHERE organization_id=a.organization_id AND approval_id=a.id;
 IF a.state IS DISTINCT FROM folded OR (folded<>'PENDING' AND EXISTS(SELECT 1 FROM approval_stage WHERE organization_id=a.organization_id AND approval_id=a.id AND state='PENDING'))
 THEN RAISE EXCEPTION 'employee approval must reflect its actual configured stage decisions';END IF;
 FOR stage IN SELECT * FROM approval_stage WHERE organization_id=a.organization_id AND approval_id=a.id AND state IN('APPROVED','REJECTED') LOOP
  IF NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id AND x.resource_type='employee_compensation_submission' AND x.resource_id=source_id
   AND x.action='finance.employee_compensation.approval_stage_decided' AND x.actor_id=stage.decided_by AND x.reason=stage.decision_reason
   AND x.after->>'stageId'=stage.id::text AND x.after->>'state'=stage.state AND x.after->>'lineId'=stage.employee_cost_id::text
   AND (x.after->>'amount')::numeric=stage.amount AND x.after->>'currency'=stage.currency)
  THEN RAISE EXCEPTION 'employee cost decision requires its exact attributed source audit';END IF;
 END LOOP;
 IF folded<>'PENDING' AND NOT EXISTS(SELECT 1 FROM audit_log x WHERE x.organization_id=a.organization_id AND x.resource_type='employee_compensation_submission' AND x.resource_id=source_id
  AND x.action='finance.employee_compensation.'||lower(folded) AND x.actor_id=a.decided_by AND x.reason=a.decision_reason AND x.after->>'approvalId'=a.id::text AND x.after->>'state'=folded)
 THEN RAISE EXCEPTION 'employee review completion requires its actual attributed audit';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_review_complete AFTER UPDATE ON approval_stage DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_review_complete();
CREATE CONSTRAINT TRIGGER employee_review_complete AFTER UPDATE ON approval_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_review_complete();

COMMIT;
