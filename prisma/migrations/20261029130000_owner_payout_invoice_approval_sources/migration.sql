BEGIN;
-- Preserve all three financial source paths after the independent payout and invoice integrations.
-- No financial rows, approval snapshots or prior migration bytes are rewritten.
ALTER TABLE approval_request ADD CONSTRAINT approval_request_one_financial_source CHECK
 ((expense_id IS NOT NULL)::integer+(payout_id IS NOT NULL)::integer+(invoice_submission_id IS NOT NULL)::integer<=1);

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
  AND NOT EXISTS (SELECT 1 FROM approval_request a JOIN owner_payout p ON p.organization_id=a.organization_id AND p.id=a.payout_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND p.state='PENDING_APPROVAL' AND p.currency=NEW.currency AND p.amount=NEW.amount AND p.owner_id=NEW.owner_id)
  THEN RAISE EXCEPTION 'financial approval stage requires its submitted expense, invoice or owner payout'; END IF;
 ELSE
  IF ROW(NEW.organization_id,NEW.id,NEW.approval_id,NEW.position,NEW.kind,NEW.owner_id,NEW.amount,NEW.currency,NEW.routing_snapshot)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.approval_id,OLD.position,OLD.kind,OLD.owner_id,OLD.amount,OLD.currency,OLD.routing_snapshot)
   OR OLD.state<>'PENDING' OR NEW.state NOT IN ('APPROVED','REJECTED','CANCELLED')
   OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR NEW.decision_reason IS NULL OR length(trim(NEW.decision_reason))<6
  THEN RAISE EXCEPTION 'financial approval decisions are immutable and require attribution'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_financial_recipient_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM approval_request a WHERE a.organization_id=OLD.organization_id AND a.id=OLD.approval_id
   AND (a.expense_id IS NOT NULL OR a.payout_id IS NOT NULL OR a.invoice_submission_id IS NOT NULL)) THEN RAISE EXCEPTION 'financial approval recipients are append-only'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;

COMMIT;
