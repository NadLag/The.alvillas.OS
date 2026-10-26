-- Additive guards only. Existing business and financial rows are preserved.
CREATE FUNCTION app_financial_approval_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expense%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.expense_id IS NOT NULL THEN RAISE EXCEPTION 'financial approval history cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.expense_id IS NOT NULL OR NEW.expense_id IS NOT NULL) THEN
  IF ROW(NEW.id,NEW.organization_id,NEW.expense_id,NEW.property_id,NEW.requested_by,NEW.title,NEW.details,NEW.routing_snapshot,NEW.idempotency_key,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.expense_id,OLD.property_id,OLD.requested_by,OLD.title,OLD.details,OLD.routing_snapshot,OLD.idempotency_key,OLD.created_at)
  THEN RAISE EXCEPTION 'financial approval source and routing are immutable'; END IF;
 END IF;
 IF NEW.expense_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO e FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.expense_id;
 IF NOT FOUND OR e.property_id<>NEW.property_id OR NOT EXISTS (
   SELECT 1 FROM expense_submission s WHERE s.organization_id=e.organization_id AND s.expense_id=e.id AND s.submitted_by=NEW.requested_by)
 THEN RAISE EXCEPTION 'financial approval requires its original submitted source'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'PENDING' OR e.state<>'PENDING_APPROVAL' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_reason IS NOT NULL
  THEN RAISE EXCEPTION 'financial approval starts pending'; END IF;
 ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
  IF OLD.state<>'PENDING' OR NEW.state NOT IN ('APPROVED','REJECTED') OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR length(trim(COALESCE(NEW.decision_reason,'')))<6
  THEN RAISE EXCEPTION 'financial approval decision requires immutable attribution'; END IF;
  IF NOT EXISTS (SELECT 1 FROM approval_stage s WHERE s.organization_id=NEW.organization_id AND s.approval_id=NEW.id AND s.state=NEW.state
      AND s.decided_by=NEW.decided_by AND s.decided_at=NEW.decided_at AND s.decision_reason=NEW.decision_reason)
   OR EXISTS (SELECT 1 FROM approval_stage s WHERE s.organization_id=NEW.organization_id AND s.approval_id=NEW.id
      AND (s.state='PENDING' OR (NEW.state='APPROVED' AND s.state<>'APPROVED')))
  THEN RAISE EXCEPTION 'financial approval must finish its configured stages'; END IF;
 ELSIF ROW(NEW.decided_by,NEW.decided_at,NEW.decision_reason) IS DISTINCT FROM ROW(OLD.decided_by,OLD.decided_at,OLD.decision_reason)
 THEN RAISE EXCEPTION 'financial approval decision is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_approval_header_guard BEFORE INSERT OR UPDATE OR DELETE ON approval_request
 FOR EACH ROW EXECUTE FUNCTION app_financial_approval_header_guard();

CREATE FUNCTION app_financial_stage_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a approval_request%ROWTYPE;
BEGIN
 SELECT * INTO a FROM approval_request WHERE organization_id=NEW.organization_id AND id=NEW.approval_id FOR UPDATE;
 IF a.state<>'PENDING' THEN RAISE EXCEPTION 'financial approval is no longer pending'; END IF;
 IF NEW.state IN ('APPROVED','REJECTED') THEN
  IF EXISTS (SELECT 1 FROM approval_stage s WHERE s.organization_id=NEW.organization_id AND s.approval_id=NEW.approval_id AND s.position<NEW.position AND s.state<>'APPROVED')
   OR NOT EXISTS (SELECT 1 FROM approval_stage_recipient r WHERE r.organization_id=NEW.organization_id AND r.stage_id=NEW.id AND r.user_account_id=NEW.decided_by)
  THEN RAISE EXCEPTION 'financial approval requires its ordered recipient'; END IF;
 ELSIF NEW.state='CANCELLED' AND NOT EXISTS (SELECT 1 FROM approval_stage s WHERE s.organization_id=NEW.organization_id AND s.approval_id=NEW.approval_id
   AND s.position<NEW.position AND s.state='REJECTED' AND s.decided_by=NEW.decided_by AND s.decided_at=NEW.decided_at AND s.decision_reason=NEW.decision_reason)
 THEN RAISE EXCEPTION 'financial stage cancellation requires its preceding rejection'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_stage_order_guard BEFORE UPDATE OF state ON approval_stage
 FOR EACH ROW EXECUTE FUNCTION app_financial_stage_order_guard();

CREATE FUNCTION app_financial_recipient_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM approval_request a WHERE a.organization_id=OLD.organization_id AND a.id=OLD.approval_id AND a.expense_id IS NOT NULL)
 THEN RAISE EXCEPTION 'financial approval recipients are append-only'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_recipient_history_guard BEFORE UPDATE OR DELETE ON approval_recipient
 FOR EACH ROW EXECUTE FUNCTION app_financial_recipient_history_guard();

CREATE FUNCTION app_assert_expense_integrity(expense_uuid uuid, organization_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e expense%ROWTYPE; s expense_submission%ROWTYPE; a approval_request%ROWTYPE; step approval_stage%ROWTYPE;
 expected jsonb; expected_count integer; source_recipients text[]; actual_recipients text[];
BEGIN
 SELECT * INTO e FROM expense WHERE organization_id=organization_uuid AND id=expense_uuid;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO s FROM expense_submission WHERE organization_id=organization_uuid AND expense_id=expense_uuid;
 IF e.state='DRAFT' THEN
  IF s.id IS NOT NULL OR EXISTS (SELECT 1 FROM approval_request WHERE organization_id=organization_uuid AND expense_id=expense_uuid)
  THEN RAISE EXCEPTION 'expense drafts cannot contain a submission or approval'; END IF;
  RETURN;
 END IF;
 IF s.id IS NULL OR (s.snapshot->>'schemaVersion')::integer IS DISTINCT FROM 1
  OR COALESCE((s.snapshot->>'sourceExpenseVersion')::integer NOT BETWEEN 1 AND e.version-1,true)
  OR s.snapshot->>'propertyId' IS DISTINCT FROM e.property_id::text OR s.snapshot->>'reservationId' IS DISTINCT FROM e.reservation_id::text
  OR (s.snapshot#>>'{amount,amount}')::numeric IS DISTINCT FROM e.amount OR s.snapshot#>>'{amount,currency}' IS DISTINCT FROM e.currency
  OR s.snapshot->>'fundingAccountId' IS DISTINCT FROM e.funding_account_id::text OR s.snapshot->>'category' IS DISTINCT FROM e.category
  OR s.snapshot->>'purpose' IS DISTINCT FROM e.purpose OR s.snapshot->>'occurredOn' IS DISTINCT FROM e.occurred_on::text
  OR (s.snapshot->>'emergency')::boolean IS DISTINCT FROM e.emergency OR jsonb_typeof(s.snapshot->'stages') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'expense submission must retain its original financial facts'; END IF;
 IF NOT EXISTS (SELECT 1 FROM outbox_event o WHERE o.organization_id=e.organization_id AND o.idempotency_key='expense:'||e.id||':ExpenseSubmitted'
    AND o.type='ExpenseSubmitted' AND o.payload->>'expenseId'=e.id::text AND o.payload->>'submissionId'=s.id::text)
  OR NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.organization_id=e.organization_id AND l.resource_type='expense' AND l.resource_id=e.id
    AND l.action='expense.submitted' AND l.actor_id=s.submitted_by)
 THEN RAISE EXCEPTION 'expense submission requires its atomic native event and audit'; END IF;
 expected_count=jsonb_array_length(s.snapshot->'stages');
 SELECT * INTO a FROM approval_request WHERE organization_id=e.organization_id AND expense_id=e.id;
 IF expected_count=0 THEN
  IF a.id IS NOT NULL OR e.state NOT IN ('APPROVED','POSTED','VOIDED') OR NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.organization_id=e.organization_id
    AND l.resource_type='expense' AND l.resource_id=e.id AND l.action='expense.approved_by_policy')
  THEN RAISE EXCEPTION 'expense requires its configured approval result'; END IF;
 ELSE
  IF a.id IS NULL OR (SELECT count(*) FROM approval_stage WHERE organization_id=e.organization_id AND approval_id=a.id)<>expected_count
   OR (e.state='PENDING_APPROVAL' AND a.state<>'PENDING') OR (e.state IN ('APPROVED','POSTED','VOIDED') AND a.state<>'APPROVED')
   OR (e.state='REJECTED' AND a.state<>'REJECTED') THEN RAISE EXCEPTION 'expense and configured approval lifecycle must agree'; END IF;
  FOR step IN SELECT * FROM approval_stage WHERE organization_id=e.organization_id AND approval_id=a.id ORDER BY position LOOP
   expected=s.snapshot->'stages'->(step.position-1);
   IF expected IS NULL OR step.kind IS DISTINCT FROM expected->>'kind' OR step.owner_id::text IS DISTINCT FROM expected->>'ownerId'
    OR step.amount IS DISTINCT FROM e.amount OR step.currency IS DISTINCT FROM e.currency OR step.routing_snapshot IS DISTINCT FROM expected->'routing'
   THEN RAISE EXCEPTION 'financial approval stages must match their submitted policy'; END IF;
   SELECT array_agg(value ORDER BY value) INTO source_recipients FROM jsonb_array_elements_text(expected->'recipients');
   SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual_recipients FROM approval_stage_recipient WHERE organization_id=e.organization_id AND stage_id=step.id;
   IF source_recipients IS NULL OR source_recipients IS DISTINCT FROM actual_recipients THEN RAISE EXCEPTION 'financial stage recipients must match their submitted policy'; END IF;
   IF step.state IN ('APPROVED','REJECTED') AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.organization_id=e.organization_id AND l.resource_type='expense'
     AND l.resource_id=e.id AND l.action='expense.approval_stage_decided' AND l.actor_id=step.decided_by
     AND l.after->>'stageId'=step.id::text AND l.after->>'state'=step.state)
   THEN RAISE EXCEPTION 'financial stage decision requires its atomic audit'; END IF;
  END LOOP;
  IF e.state IN ('APPROVED','REJECTED') AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.organization_id=e.organization_id AND l.resource_type='expense'
    AND l.resource_id=e.id AND l.action=CASE WHEN e.state='APPROVED' THEN 'expense.approved' ELSE 'expense.rejected' END)
  THEN RAISE EXCEPTION 'financial approval result requires its atomic audit'; END IF;
  SELECT array_agg(DISTINCT r.user_account_id::text ORDER BY r.user_account_id::text) INTO source_recipients FROM approval_stage_recipient r JOIN approval_stage t ON t.organization_id=r.organization_id AND t.id=r.stage_id
   WHERE t.organization_id=e.organization_id AND t.approval_id=a.id;
  SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual_recipients FROM approval_recipient WHERE organization_id=e.organization_id AND approval_id=a.id;
  IF source_recipients IS DISTINCT FROM actual_recipients THEN RAISE EXCEPTION 'financial approval audience must match its stages'; END IF;
 END IF;
END $$;

CREATE FUNCTION app_expense_integrity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expense_uuid uuid; approval_uuid uuid;
BEGIN
 IF TG_TABLE_NAME='expense' THEN expense_uuid=NEW.id;
 ELSIF TG_TABLE_NAME='expense_submission' THEN expense_uuid=NEW.expense_id;
 ELSIF TG_TABLE_NAME='approval_request' THEN expense_uuid=NEW.expense_id;
 ELSIF TG_TABLE_NAME IN ('approval_stage','approval_recipient') THEN approval_uuid=NEW.approval_id;
 ELSE SELECT approval_id INTO approval_uuid FROM approval_stage WHERE organization_id=NEW.organization_id AND id=NEW.stage_id;
 END IF;
 IF expense_uuid IS NULL AND approval_uuid IS NOT NULL THEN SELECT expense_id INTO expense_uuid FROM approval_request WHERE organization_id=NEW.organization_id AND id=approval_uuid; END IF;
 IF expense_uuid IS NOT NULL THEN PERFORM app_assert_expense_integrity(expense_uuid,NEW.organization_id); END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER expense_integrity AFTER INSERT OR UPDATE ON expense DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_integrity_guard();
CREATE CONSTRAINT TRIGGER expense_submission_integrity AFTER INSERT ON expense_submission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_integrity_guard();
CREATE CONSTRAINT TRIGGER financial_approval_integrity AFTER INSERT OR UPDATE ON approval_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_integrity_guard();
CREATE CONSTRAINT TRIGGER financial_stage_integrity AFTER INSERT OR UPDATE ON approval_stage DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_integrity_guard();
CREATE CONSTRAINT TRIGGER financial_recipient_integrity AFTER INSERT ON approval_recipient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_integrity_guard();
CREATE CONSTRAINT TRIGGER financial_stage_recipient_integrity AFTER INSERT ON approval_stage_recipient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_integrity_guard();
