BEGIN;

-- Complete claim reversal shares the exact same invoice lock as actual supplier payments.
CREATE FUNCTION app_supplier_claim_reversal_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal financial_transaction%ROWTYPE; invoice_uuid uuid;
BEGIN
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'SUPPLIER_INVOICE' THEN RETURN NEW; END IF;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id;
 IF journal.reverses_transaction_id IS NULL THEN RETURN NEW; END IF;
 invoice_uuid=(NEW.dimensions->>'supplier_invoice_id')::uuid;
 IF invoice_uuid IS NULL THEN RAISE EXCEPTION 'supplier claim reversal requires its actual invoice'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':supplier-invoice:'||invoice_uuid,0));
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_claim_reversal_lock BEFORE INSERT ON posting FOR EACH ROW EXECUTE FUNCTION app_supplier_claim_reversal_lock();

CREATE FUNCTION app_assert_supplier_invoice_claim_reversal(org_uuid uuid,recognition_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r supplier_invoice_recognition%ROWTYPE; cost_count integer; reversal_count integer; actor_uuid uuid; point timestamptz;
 original_ids jsonb; reversal_ids jsonb; audit audit_log%ROWTYPE;
BEGIN
 SELECT * INTO r FROM supplier_invoice_recognition WHERE organization_id=org_uuid AND id=recognition_uuid;
 IF r.id IS NULL THEN RAISE EXCEPTION 'claim reversal requires its actual original recognition'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org_uuid::text||':supplier-invoice:'||r.invoice_id,0));
 PERFORM app_assert_supplier_invoice_recognition(org_uuid,r.id);
 SELECT count(*),jsonb_agg(l.transaction_id::text ORDER BY l.invoice_line_id) INTO cost_count,original_ids
  FROM supplier_invoice_recognition_line l WHERE l.organization_id=org_uuid AND l.recognition_id=r.id;
 SELECT count(*),jsonb_agg(v.id::text ORDER BY l.invoice_line_id) INTO reversal_count,reversal_ids
  FROM supplier_invoice_recognition_line l JOIN financial_transaction v ON v.organization_id=l.organization_id AND v.reverses_transaction_id=l.transaction_id
  WHERE l.organization_id=org_uuid AND l.recognition_id=r.id;
 IF cost_count=0 OR reversal_count<>cost_count THEN RAISE EXCEPTION 'supplier claim reversal must include every original cost atomically'; END IF;
 SELECT v.created_by,v.occurred_at INTO actor_uuid,point FROM supplier_invoice_recognition_line l
  JOIN financial_transaction v ON v.organization_id=l.organization_id AND v.reverses_transaction_id=l.transaction_id
  WHERE l.organization_id=org_uuid AND l.recognition_id=r.id ORDER BY l.invoice_line_id LIMIT 1;
 SELECT * INTO audit FROM audit_log a WHERE a.organization_id=org_uuid AND a.resource_type='supplier_invoice' AND a.resource_id=r.invoice_id
  AND a.action='finance.supplier_invoice.reversed' ORDER BY a.created_at LIMIT 1;
 IF audit.id IS NULL OR actor_uuid IS NULL OR audit.actor_id IS DISTINCT FROM actor_uuid OR audit.reason IS NULL OR length(btrim(audit.reason)) NOT BETWEEN 6 AND 500
  OR audit.after->>'recognitionId' IS DISTINCT FROM r.id::text OR (audit.after->>'invoiceVersion')::integer IS DISTINCT FROM r.invoice_version
  OR (audit.after->>'idempotencyKey')::uuid IS NULL
  OR ((audit.after->>'idempotencyKey')::uuid)::text IS DISTINCT FROM audit.after->>'idempotencyKey'
  OR jsonb_typeof(audit.after->'invoiceVersion') IS DISTINCT FROM 'number'
  OR point<date_trunc('milliseconds',transaction_timestamp()) OR point>clock_timestamp() OR NOT app_financial_period_is_open(org_uuid,point)
  OR jsonb_typeof(audit.after->'originalTransactionIds') IS DISTINCT FROM 'array' OR jsonb_typeof(audit.after->'reversalTransactionIds') IS DISTINCT FROM 'array'
  OR jsonb_array_length(audit.after->'originalTransactionIds')<>cost_count OR jsonb_array_length(audit.after->'reversalTransactionIds')<>cost_count
  OR NOT ((audit.after->'originalTransactionIds') @> original_ids AND original_ids @> (audit.after->'originalTransactionIds')
    AND (audit.after->'reversalTransactionIds') @> reversal_ids AND reversal_ids @> (audit.after->'reversalTransactionIds'))
  OR (SELECT count(*) FROM audit_log a WHERE a.organization_id=org_uuid AND a.resource_type='supplier_invoice' AND a.resource_id=r.invoice_id AND a.action='finance.supplier_invoice.reversed')<>1
  OR EXISTS(SELECT 1 FROM supplier_invoice_recognition_line l JOIN financial_transaction v ON v.organization_id=l.organization_id AND v.reverses_transaction_id=l.transaction_id
    JOIN financial_transaction original ON original.organization_id=l.organization_id AND original.id=l.transaction_id
    WHERE l.organization_id=org_uuid AND l.recognition_id=r.id AND (v.created_by IS DISTINCT FROM actor_uuid OR v.occurred_at IS DISTINCT FROM point
      OR v.description IS DISTINCT FROM audit.reason OR v.reference IS DISTINCT FROM original.reference||':VOID' OR v.idempotency_key IS DISTINCT FROM original.idempotency_key||':void'))
 THEN RAISE EXCEPTION 'supplier claim reversal requires its complete canonical attributed atomic receipt'; END IF;
 IF EXISTS(SELECT 1 FROM financial_transaction t JOIN posting p ON p.organization_id=t.organization_id AND p.transaction_id=t.id
   WHERE t.organization_id=org_uuid AND t.reverses_transaction_id IS NULL AND p.bucket='SUPPLIER_PAYMENT'
    AND p.dimensions->>'supplier_invoice_id'=r.invoice_id::text
    AND NOT EXISTS(SELECT 1 FROM financial_transaction v WHERE v.organization_id=org_uuid AND v.reverses_transaction_id=t.id))
 THEN RAISE EXCEPTION 'reverse every actual supplier payment before reversing its claim'; END IF;
 IF EXISTS(SELECT p.currency FROM posting p
   JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
   WHERE p.organization_id=org_uuid AND a.code='SUPPLIER_PAYABLE' AND p.dimensions->>'supplier_invoice_id'=r.invoice_id::text
   GROUP BY p.currency HAVING sum(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END)<>0)
 THEN RAISE EXCEPTION 'a completely reversed supplier claim must have zero derived outstanding'; END IF;
 -- Existing global ledger guards independently require each exact opposite posting multiset and an open posting period.
END $$;

CREATE OR REPLACE FUNCTION app_supplier_invoice_posting_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link supplier_invoice_recognition_line%ROWTYPE; journal financial_transaction%ROWTYPE; driver_uuid uuid;
BEGIN
 IF NEW.dimensions->>'source' IS DISTINCT FROM 'SUPPLIER_INVOICE' THEN RETURN NEW; END IF;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id;
 SELECT * INTO link FROM supplier_invoice_recognition_line WHERE organization_id=NEW.organization_id
  AND transaction_id=COALESCE(journal.reverses_transaction_id,journal.id) AND invoice_line_id::text=NEW.dimensions->>'supplier_invoice_line_id';
 IF link.id IS NULL THEN RAISE EXCEPTION 'supplier invoice postings require their actual atomic recognized cost source'; END IF;
 PERFORM app_assert_supplier_invoice_recognition_line(NEW.organization_id,link.id);
 IF journal.reverses_transaction_id IS NOT NULL THEN
  -- Every nonempty attempted set has one actual smallest reversal. It must prove the whole original cost set.
  SELECT v.id INTO driver_uuid FROM supplier_invoice_recognition_line l JOIN financial_transaction v
   ON v.organization_id=l.organization_id AND v.reverses_transaction_id=l.transaction_id
   WHERE l.organization_id=NEW.organization_id AND l.recognition_id=link.recognition_id ORDER BY v.id LIMIT 1;
  IF journal.id=driver_uuid THEN PERFORM app_assert_supplier_invoice_claim_reversal(NEW.organization_id,link.recognition_id); END IF;
 END IF;
 RETURN NEW;
END $$;

COMMIT;
