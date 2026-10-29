BEGIN;
-- Extend the shared source guard without changing the existing expense path.
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
  THEN RAISE EXCEPTION 'financial approval stage requires its submitted expense or invoice'; END IF;
 ELSE
  IF ROW(NEW.organization_id,NEW.id,NEW.approval_id,NEW.position,NEW.kind,NEW.owner_id,NEW.amount,NEW.currency,NEW.routing_snapshot)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.approval_id,OLD.position,OLD.kind,OLD.owner_id,OLD.amount,OLD.currency,OLD.routing_snapshot)
   OR OLD.state<>'PENDING' OR NEW.state NOT IN ('APPROVED','REJECTED','CANCELLED')
   OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR NEW.decision_reason IS NULL OR length(trim(NEW.decision_reason))<6
  THEN RAISE EXCEPTION 'financial approval decisions are immutable and require attribution'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- Invoice and approval headers use distinct names for the same pending state.
CREATE OR REPLACE FUNCTION app_assert_supplier_invoice_submission(org_uuid uuid,source_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s supplier_invoice_submission%ROWTYPE; i supplier_invoice%ROWTYPE; r supplier_invoice_revision%ROWTYPE; a approval_request%ROWTYPE;
 expected jsonb; entry jsonb; step approval_stage%ROWTYPE; source_count integer; source_recipients text[]; actual_recipients text[];
BEGIN
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=org_uuid AND id=source_uuid;
 SELECT * INTO i FROM supplier_invoice WHERE organization_id=org_uuid AND id=s.invoice_id;
 SELECT * INTO r FROM supplier_invoice_revision WHERE organization_id=org_uuid AND id=s.revision_id;
 IF s.id IS NULL OR i.id IS NULL OR r.invoice_id IS DISTINCT FROM i.id OR i.current_submission_id IS DISTINCT FROM s.id OR i.current_revision_id IS DISTINCT FROM r.id
  OR i.version<s.source_invoice_version+1 OR s.snapshot->>'invoiceId' IS DISTINCT FROM i.id::text OR s.snapshot->>'revisionId' IS DISTINCT FROM r.id::text
  OR s.snapshot->>'sourceInvoiceVersion' IS DISTINCT FROM s.source_invoice_version::text OR s.snapshot->>'occurredOn' IS DISTINCT FROM s.occurred_on::text
  OR s.snapshot->>'emergency' IS DISTINCT FROM s.emergency::text OR (s.snapshot->'amount'->>'amount')::numeric IS DISTINCT FROM r.amount OR s.snapshot->'amount'->>'currency' IS DISTINCT FROM r.currency
  OR jsonb_typeof(s.snapshot->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(s.snapshot->'stages') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'supplier invoice submission requires its exact immutable source facts'; END IF;
 SELECT count(*) INTO source_count FROM supplier_invoice_line WHERE organization_id=org_uuid AND revision_id=r.id;
 IF source_count<>jsonb_array_length(s.snapshot->'lines') OR EXISTS (
  SELECT 1 FROM jsonb_array_elements(s.snapshot->'lines') x LEFT JOIN supplier_invoice_line l ON l.organization_id=org_uuid AND l.id=(x->>'id')::uuid AND l.revision_id=r.id
  WHERE l.id IS NULL OR l.position IS DISTINCT FROM (x->>'position')::integer OR l.property_id::text IS DISTINCT FROM x->>'propertyId'
   OR l.reservation_id::text IS DISTINCT FROM x->>'reservationId' OR l.amount IS DISTINCT FROM (x->'amount'->>'amount')::numeric OR l.currency IS DISTINCT FROM x->'amount'->>'currency'
   OR l.category IS DISTINCT FROM x->>'category' OR l.cost_center IS DISTINCT FROM x->>'costCenter' OR COALESCE(length(btrim(x->>'approvalNote')),0) NOT BETWEEN 6 AND 1000
   OR x->'policy'->>'sourceKind' IS DISTINCT FROM 'supplier_invoice_line' OR x->'policy'->>'invoiceId' IS DISTINCT FROM i.id::text
   OR x->'policy'->>'revisionId' IS DISTINCT FROM r.id::text OR x->'policy'->>'lineId' IS DISTINCT FROM l.id::text
   OR x->'policy'->>'occurredOn' IS DISTINCT FROM s.occurred_on::text OR COALESCE(length(x->'policy'->>'timezone'),0)=0
   OR ((x->'policy'->'allocation'->'owner'->>'amount')::numeric+(x->'policy'->'allocation'->'alvillas'->>'amount')::numeric
     +(x->'policy'->'allocation'->'guest'->>'amount')::numeric) IS DISTINCT FROM l.amount
   OR EXISTS (SELECT 1 FROM (VALUES (x->'policy'->'allocation'->'owner'),(x->'policy'->'allocation'->'alvillas'),(x->'policy'->'allocation'->'guest')) allocation(value)
     WHERE value->>'currency' IS DISTINCT FROM l.currency OR (value->>'amount')::numeric<0 OR trunc((value->>'amount')::numeric*100)<>(value->>'amount')::numeric*100))
  OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(s.snapshot->'lines') x)<>source_count
  THEN RAISE EXCEPTION 'supplier invoice submission must preserve every actual allocation line and its review note'; END IF;
 IF NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.organization_id=org_uuid AND x.resource_type='supplier_invoice' AND x.resource_id=i.id
   AND x.action='finance.supplier_invoice.submitted' AND x.actor_id=s.submitted_by AND x.reason=s.reason
   AND x.after->>'submissionId'=s.id::text AND x.after->>'revisionId'=r.id::text AND x.after->>'version'=(s.source_invoice_version+1)::text)
  THEN RAISE EXCEPTION 'supplier invoice submission requires its attributed source audit'; END IF;
 SELECT * INTO a FROM approval_request WHERE organization_id=org_uuid AND invoice_submission_id=s.id;
 IF jsonb_array_length(s.snapshot->'stages')=0 THEN
  IF a.id IS NOT NULL OR i.state<>'APPROVED' THEN RAISE EXCEPTION 'invoice without required review must be approved by its explicit policy'; END IF;
 ELSE
  IF a.id IS NULL OR a.state IS DISTINCT FROM (CASE WHEN i.state='PENDING_APPROVAL' THEN 'PENDING' ELSE i.state END) OR (a.state<>'PENDING' AND a.decided_by<>i.updated_by)
   OR (SELECT count(*) FROM approval_stage WHERE organization_id=org_uuid AND approval_id=a.id)<>jsonb_array_length(s.snapshot->'stages')
   THEN RAISE EXCEPTION 'supplier invoice requires its complete configured approval'; END IF;
  FOR expected,source_count IN SELECT value,ordinality::integer FROM jsonb_array_elements(s.snapshot->'stages') WITH ORDINALITY LOOP
   SELECT * INTO step FROM approval_stage WHERE organization_id=org_uuid AND approval_id=a.id AND position=source_count;
   IF step.id IS NULL OR step.kind IS DISTINCT FROM expected->>'kind' OR step.owner_id::text IS DISTINCT FROM expected->>'ownerId'
    OR step.amount IS DISTINCT FROM (expected->>'amount')::numeric OR step.currency IS DISTINCT FROM expected->>'currency'
    OR step.invoice_line_id::text IS DISTINCT FROM expected->>'lineId' OR step.property_id::text IS DISTINCT FROM expected->>'propertyId'
    OR step.reservation_id::text IS DISTINCT FROM expected->>'reservationId' OR step.source_snapshot IS DISTINCT FROM expected->'sourceSnapshot'
    OR step.routing_snapshot IS DISTINCT FROM expected->'routing' THEN RAISE EXCEPTION 'supplier invoice approval must match its frozen policy stage'; END IF;
   SELECT array_agg(value ORDER BY value) INTO source_recipients FROM jsonb_array_elements_text(expected->'recipients');
   SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual_recipients FROM approval_stage_recipient WHERE organization_id=org_uuid AND stage_id=step.id;
   IF source_recipients IS DISTINCT FROM actual_recipients OR COALESCE(array_length(source_recipients,1),0)=0
    THEN RAISE EXCEPTION 'supplier invoice approval audience must match its frozen policy'; END IF;
   IF step.state IN ('APPROVED','REJECTED') AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.organization_id=org_uuid AND x.resource_type='supplier_invoice'
     AND x.resource_id=i.id AND x.action='finance.supplier_invoice.approval_stage_decided' AND x.actor_id=step.decided_by
     AND x.after->>'stageId'=step.id::text AND x.after->>'state'=step.state AND x.after->>'lineId'=step.invoice_line_id::text)
    THEN RAISE EXCEPTION 'supplier invoice approval decisions require their attributed source audit'; END IF;
  END LOOP;
  SELECT array_agg(DISTINCT x.user_account_id::text ORDER BY x.user_account_id::text) INTO source_recipients FROM approval_stage_recipient x
    JOIN approval_stage y ON y.organization_id=x.organization_id AND y.id=x.stage_id WHERE x.organization_id=org_uuid AND y.approval_id=a.id;
  SELECT array_agg(user_account_id::text ORDER BY user_account_id::text) INTO actual_recipients FROM approval_recipient WHERE organization_id=org_uuid AND approval_id=a.id;
  IF source_recipients IS DISTINCT FROM actual_recipients THEN RAISE EXCEPTION 'supplier invoice approval audience must match its stage audience'; END IF;
 END IF;
END; $$;

COMMIT;
