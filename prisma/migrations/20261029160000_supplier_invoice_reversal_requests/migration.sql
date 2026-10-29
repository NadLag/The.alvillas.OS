BEGIN;

-- A constant default retains all old immutable request tuples and their recognition semantics.
ALTER TABLE supplier_invoice_recognition_request ADD COLUMN operation text NOT NULL DEFAULT 'RECOGNIZE';
ALTER TABLE supplier_invoice_recognition_request ADD CONSTRAINT supplier_invoice_financial_request_operation
 CHECK(operation IN ('RECOGNIZE','REVERSE') AND (operation<>'REVERSE' OR current_period=false));

CREATE OR REPLACE FUNCTION app_supplier_invoice_recognition_request_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i supplier_invoice%ROWTYPE; s supplier_invoice_submission%ROWTYPE;
BEGIN
 SELECT * INTO i FROM supplier_invoice WHERE organization_id=NEW.organization_id AND id=NEW.invoice_id;
 SELECT * INTO s FROM supplier_invoice_submission WHERE organization_id=NEW.organization_id AND id=NEW.submission_id;
 IF i.id IS NULL OR s.id IS NULL OR i.state<>'APPROVED' OR i.archived_at IS NOT NULL OR i.version<>NEW.invoice_version
  OR i.current_submission_id IS DISTINCT FROM s.id OR s.invoice_id<>i.id OR i.current_revision_id IS DISTINCT FROM s.revision_id
  OR EXISTS(SELECT 1 FROM supplier v WHERE v.organization_id=i.organization_id AND v.id=i.supplier_id AND v.archived_at IS NOT NULL)
  OR (jsonb_array_length(s.snapshot->'stages')>0 AND NOT EXISTS(SELECT 1 FROM approval_request a
    WHERE a.organization_id=i.organization_id AND a.invoice_submission_id=s.id AND a.state='APPROVED'
      AND NOT EXISTS(SELECT 1 FROM approval_stage p WHERE p.organization_id=a.organization_id AND p.approval_id=a.id AND p.state<>'APPROVED')))
 THEN RAISE EXCEPTION 'recognition request requires its actual current approved invoice and review source'; END IF;
 IF NEW.operation='REVERSE' AND NOT EXISTS(SELECT 1 FROM supplier_invoice_recognition r WHERE r.organization_id=NEW.organization_id
   AND r.invoice_id=NEW.invoice_id AND r.submission_id=NEW.submission_id AND r.invoice_version=NEW.invoice_version)
 THEN RAISE EXCEPTION 'reversal request requires its actual original recognized claim'; END IF;
 NEW.requested_at=clock_timestamp(); RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_supplier_invoice_recognition_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prefix text; action_name text; request_field text; event_type text;
BEGIN
 prefix=CASE WHEN NEW.operation='RECOGNIZE' THEN 'supplier-invoice-recognition' ELSE 'supplier-invoice-reversal' END;
 action_name=CASE WHEN NEW.operation='RECOGNIZE' THEN 'finance.supplier_invoice.recognition_requested' ELSE 'finance.supplier_invoice.reversal_requested' END;
 request_field=CASE WHEN NEW.operation='RECOGNIZE' THEN 'recognitionRequestId' ELSE 'reversalRequestId' END;
 event_type=CASE WHEN NEW.operation='RECOGNIZE' THEN 'SupplierInvoiceRecognitionRequested' ELSE 'SupplierInvoiceReversalRequested' END;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.requested_by
   AND a.action=action_name AND a.resource_type='supplier_invoice' AND a.resource_id=NEW.invoice_id
   AND a.reason=NEW.reason AND a.after->>request_field=NEW.id::text AND a.after->>'submissionId'=NEW.submission_id::text)
 THEN RAISE EXCEPTION 'recognition request requires its attributed atomic audit'; END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type=event_type
   AND e.idempotency_key=prefix||':'||NEW.id::text||':requested'
   AND e.payload=jsonb_build_object('requestId',NEW.id::text) AND e.occurred_at=date_trunc('milliseconds',NEW.requested_at))
 THEN RAISE EXCEPTION 'recognition request requires its canonical opaque dispatch event'; END IF;
 RETURN NULL;
END $$;

-- Historical completion checks do not require the old posting instant to be in this transaction or an open period today.
-- Migration 79 already enforces the exact opposite, complete source, actor and zero claim when those journals are created.
CREATE FUNCTION app_supplier_invoice_reversal_matches_request(org_uuid uuid,request_uuid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM supplier_invoice_recognition_request q
  JOIN supplier_invoice_recognition r ON r.organization_id=q.organization_id AND r.invoice_id=q.invoice_id AND r.submission_id=q.submission_id
  JOIN audit_log a ON a.organization_id=q.organization_id AND a.resource_type='supplier_invoice' AND a.resource_id=q.invoice_id
   AND a.action='finance.supplier_invoice.reversed' AND a.actor_id=q.requested_by AND a.reason=q.reason
  CROSS JOIN LATERAL (SELECT count(*) AS n,jsonb_agg(l.transaction_id::text ORDER BY l.invoice_line_id) AS ids
   FROM supplier_invoice_recognition_line l WHERE l.organization_id=org_uuid AND l.recognition_id=r.id) originals
  CROSS JOIN LATERAL (SELECT count(*) AS n,jsonb_agg(v.id::text ORDER BY l.invoice_line_id) AS ids,
   bool_and(v.created_by=q.requested_by AND v.description=q.reason) AS actors
   FROM supplier_invoice_recognition_line l JOIN financial_transaction v ON v.organization_id=l.organization_id AND v.reverses_transaction_id=l.transaction_id
   WHERE l.organization_id=org_uuid AND l.recognition_id=r.id) reversals
  WHERE q.organization_id=org_uuid AND q.id=request_uuid AND q.operation='REVERSE' AND r.invoice_version=q.invoice_version
   AND a.after->>'recognitionId'=r.id::text AND a.after->>'invoiceVersion'=q.invoice_version::text AND a.after->>'idempotencyKey'=q.idempotency_key::text
   AND originals.n>0 AND reversals.n=originals.n AND reversals.actors
   AND jsonb_typeof(a.after->'originalTransactionIds')='array' AND jsonb_typeof(a.after->'reversalTransactionIds')='array'
   AND jsonb_array_length(a.after->'originalTransactionIds')=originals.n AND jsonb_array_length(a.after->'reversalTransactionIds')=originals.n
   AND (a.after->'originalTransactionIds') @> originals.ids AND originals.ids @> (a.after->'originalTransactionIds')
   AND (a.after->'reversalTransactionIds') @> reversals.ids AND reversals.ids @> (a.after->'reversalTransactionIds'));
$$;

CREATE OR REPLACE FUNCTION app_supplier_invoice_recognition_outcome_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q supplier_invoice_recognition_request%ROWTYPE; r supplier_invoice_recognition%ROWTYPE; committed boolean;
BEGIN
 SELECT * INTO q FROM supplier_invoice_recognition_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 IF q.id IS NULL THEN RAISE EXCEPTION 'recognition outcome requires its actual request'; END IF;
 IF q.operation='RECOGNIZE' THEN
  SELECT * INTO r FROM supplier_invoice_recognition WHERE organization_id=q.organization_id AND idempotency_key=q.idempotency_key;
  IF NEW.state='SUCCEEDED' THEN
   IF r.id IS NULL OR r.id IS DISTINCT FROM NEW.recognition_id OR r.invoice_id<>q.invoice_id OR r.submission_id<>q.submission_id
     OR r.invoice_version<>q.invoice_version OR r.current_period<>q.current_period OR r.created_by<>q.requested_by
     OR r.request_fingerprint<>q.request_fingerprint OR r.reason<>q.reason
   THEN RAISE EXCEPTION 'successful recognition outcome must identify the exact committed financial source'; END IF;
  ELSIF r.id IS NOT NULL AND r.request_fingerprint=q.request_fingerprint AND r.created_by=q.requested_by THEN
   RAISE EXCEPTION 'a committed recognition cannot receive a failure outcome';
  END IF;
 ELSE
  SELECT * INTO r FROM supplier_invoice_recognition WHERE organization_id=q.organization_id AND invoice_id=q.invoice_id AND submission_id=q.submission_id;
  committed=app_supplier_invoice_reversal_matches_request(q.organization_id,q.id);
  IF NEW.state='SUCCEEDED' AND (NOT committed OR r.id IS DISTINCT FROM NEW.recognition_id) THEN
   RAISE EXCEPTION 'successful reversal outcome must identify the exact complete committed cancellation';
  ELSIF NEW.state<>'SUCCEEDED' AND committed THEN
   RAISE EXCEPTION 'a committed supplier cancellation cannot receive a failure outcome';
  END IF;
 END IF;
 NEW.occurred_at=clock_timestamp(); RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_supplier_invoice_recognition_outcome_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q supplier_invoice_recognition_request%ROWTYPE; action_name text; request_field text; outcome_field text;
BEGIN
 SELECT * INTO q FROM supplier_invoice_recognition_request WHERE organization_id=NEW.organization_id AND id=NEW.request_id;
 action_name=CASE WHEN q.operation='RECOGNIZE' THEN 'finance.supplier_invoice.recognition_completed' ELSE 'finance.supplier_invoice.reversal_completed' END;
 request_field=CASE WHEN q.operation='RECOGNIZE' THEN 'recognitionRequestId' ELSE 'reversalRequestId' END;
 outcome_field=CASE WHEN q.operation='RECOGNIZE' THEN 'recognitionOutcomeId' ELSE 'reversalOutcomeId' END;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=q.organization_id AND a.actor_id=q.requested_by
   AND a.action=action_name AND a.resource_type='supplier_invoice' AND a.resource_id=q.invoice_id
   AND a.reason=q.reason AND a.after->>request_field=q.id::text AND a.after->>outcome_field=NEW.id::text
   AND a.after->>'state'=NEW.state AND (a.after->>'recognitionId') IS NOT DISTINCT FROM NEW.recognition_id::text
   AND (a.after->>'failureCode') IS NOT DISTINCT FROM NEW.failure_code)
 THEN RAISE EXCEPTION 'recognition outcome requires its attributed atomic audit'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app_supplier_invoice_recognition_event_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q supplier_invoice_recognition_request%ROWTYPE; protected_old boolean; prefix text; event_type text;
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') THEN
  protected_old=OLD.type IN ('SupplierInvoiceRecognitionRequested','SupplierInvoiceReversalRequested')
   OR OLD.idempotency_key LIKE 'supplier-invoice-recognition:%:requested' OR OLD.idempotency_key LIKE 'supplier-invoice-reversal:%:requested';
  IF protected_old AND (TG_OP='DELETE' OR ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at))
  THEN RAISE EXCEPTION 'recognition dispatch business facts are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 END IF;
 IF NEW.type IN ('SupplierInvoiceRecognitionRequested','SupplierInvoiceReversalRequested')
   OR NEW.idempotency_key LIKE 'supplier-invoice-recognition:%:requested' OR NEW.idempotency_key LIKE 'supplier-invoice-reversal:%:requested' THEN
  SELECT * INTO q FROM supplier_invoice_recognition_request WHERE organization_id=NEW.organization_id AND id::text=NEW.payload->>'requestId';
  prefix=CASE WHEN q.operation='RECOGNIZE' THEN 'supplier-invoice-recognition' ELSE 'supplier-invoice-reversal' END;
  event_type=CASE WHEN q.operation='RECOGNIZE' THEN 'SupplierInvoiceRecognitionRequested' ELSE 'SupplierInvoiceReversalRequested' END;
  IF q.id IS NULL OR NEW.type<>event_type OR NEW.idempotency_key<>prefix||':'||q.id::text||':requested'
    OR NEW.payload<>jsonb_build_object('requestId',q.id::text) OR NEW.occurred_at<>date_trunc('milliseconds',q.requested_at)
  THEN RAISE EXCEPTION 'recognition dispatch must identify its exact actual request'; END IF;
 END IF;
 RETURN NEW;
END $$;

COMMIT;
