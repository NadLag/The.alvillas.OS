BEGIN;

-- Native location transfers reuse the immutable journal and its exact reversal.
-- Only new headers are checked; existing financial rows are never rewritten.
CREATE FUNCTION app_assert_native_financial_transfer(journal_uuid uuid, organization_uuid uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE journal financial_transaction%ROWTYPE; original financial_transaction%ROWTYPE; proof audit_log%ROWTYPE;
 from_account ledger_account%ROWTYPE; to_account ledger_account%ROWTYPE;
 request_uuid uuid; source_uuid uuid; destination_uuid uuid; movement_kind text; transfer_amount numeric; transfer_currency text;
 source_wallet boolean; destination_wallet boolean; point timestamptz;
BEGIN
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=organization_uuid AND id=journal_uuid;
 IF journal.id IS NULL OR journal.reference NOT LIKE 'TRANSFER:%' THEN RETURN; END IF;
 IF journal.created_by IS NULL THEN RAISE EXCEPTION 'financial transfer requires its attributed actor'; END IF;
 point:=clock_timestamp();
 IF journal.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR journal.occurred_at>point
 THEN RAISE EXCEPTION 'financial transfer requires a new journal at the current posting time'; END IF;
 IF journal.reference ~ '^TRANSFER:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:VOID$' THEN
  request_uuid:=substring(journal.reference FROM 10 FOR 36)::uuid;
  SELECT * INTO original FROM financial_transaction WHERE organization_id=organization_uuid AND id=journal.reverses_transaction_id;
  IF original.id IS NULL OR original.reference IS DISTINCT FROM 'TRANSFER:'||request_uuid::text
   OR journal.idempotency_key IS DISTINCT FROM 'transfer:'||request_uuid::text||':void'
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction'
    AND a.resource_id=original.id AND a.action='finance.transfer.reversed' AND a.actor_id=journal.created_by
    AND a.reason=journal.description AND length(btrim(a.reason)) BETWEEN 6 AND 500
    AND a.after->'originalTransactionIds'=jsonb_build_array(original.id::text)
    AND a.after->'reversalTransactionIds'=jsonb_build_array(journal.id::text))
  THEN RAISE EXCEPTION 'financial transfer reversal requires its original journal and reasoned audit'; END IF;
  RETURN;
 END IF;
 IF journal.reference !~ '^TRANSFER:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR journal.reverses_transaction_id IS NOT NULL
 THEN RAISE EXCEPTION 'financial transfer requires its canonical source identity'; END IF;
 request_uuid:=substring(journal.reference FROM 10)::uuid;
 IF journal.idempotency_key IS DISTINCT FROM 'transfer:'||request_uuid::text
 THEN RAISE EXCEPTION 'financial transfer requires its canonical request identity'; END IF;
 SELECT * INTO proof FROM audit_log WHERE organization_id=organization_uuid AND resource_type='financial_transaction'
  AND resource_id=journal.id AND action='finance.transfer.posted' ORDER BY created_at LIMIT 1;
 IF proof.id IS NULL OR proof.actor_id IS DISTINCT FROM journal.created_by
  OR length(btrim(proof.reason)) NOT BETWEEN 6 AND 500 OR proof.reason IS NULL
  OR proof.after->>'reason' IS DISTINCT FROM proof.reason OR proof.after->>'purpose' IS DISTINCT FROM journal.description
  OR proof.after->>'idempotencyKey' IS DISTINCT FROM request_uuid::text
  OR COALESCE(proof.after->>'fromAccountId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR COALESCE(proof.after->>'toAccountId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR COALESCE(proof.after->>'amount','') !~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$'
  OR COALESCE(proof.after->>'currency','') !~ '^[A-Z]{3}$'
  OR COALESCE(proof.after->>'kind','') NOT IN ('TRANSFER','ADVANCE','RETURN')
 THEN RAISE EXCEPTION 'financial transfer requires its complete attributed source audit'; END IF;
 source_uuid:=(proof.after->>'fromAccountId')::uuid; destination_uuid:=(proof.after->>'toAccountId')::uuid;
 transfer_amount:=(proof.after->>'amount')::numeric; transfer_currency:=proof.after->>'currency'; movement_kind:=proof.after->>'kind';
 SELECT * INTO from_account FROM ledger_account WHERE organization_id=organization_uuid AND id=source_uuid;
 SELECT * INTO to_account FROM ledger_account WHERE organization_id=organization_uuid AND id=destination_uuid;
 IF source_uuid=destination_uuid OR transfer_amount<=0 OR from_account.id IS NULL OR to_account.id IS NULL
  OR from_account.archived_at IS NOT NULL OR to_account.archived_at IS NOT NULL
  OR from_account.normal_side<>'DEBIT' OR to_account.normal_side<>'DEBIT'
  OR from_account.account_type NOT IN ('ASSET','ASSET_LOCATION','STAFF_WALLET') OR to_account.account_type NOT IN ('ASSET','ASSET_LOCATION','STAFF_WALLET')
  OR left(from_account.code,13)='CASH_CUSTODY_' OR left(to_account.code,13)='CASH_CUSTODY_'
  OR NOT EXISTS(SELECT 1 FROM currency c WHERE c.code=transfer_currency AND c.minor_unit<=2 AND transfer_amount=round(transfer_amount,c.minor_unit))
 THEN RAISE EXCEPTION 'financial transfer requires distinct active location accounts and one supported currency'; END IF;
 source_wallet:=from_account.account_type='STAFF_WALLET'; destination_wallet:=to_account.account_type='STAFF_WALLET';
 IF (source_wallet AND NOT EXISTS(SELECT 1 FROM team_wallet w JOIN person p ON p.organization_id=w.organization_id AND p.id=w.person_id
    WHERE w.organization_id=organization_uuid AND w.ledger_account_id=source_uuid AND p.archived_at IS NULL))
  OR (destination_wallet AND NOT EXISTS(SELECT 1 FROM team_wallet w JOIN person p ON p.organization_id=w.organization_id AND p.id=w.person_id
    WHERE w.organization_id=organization_uuid AND w.ledger_account_id=destination_uuid AND p.archived_at IS NULL))
  OR (movement_kind='ADVANCE' AND (source_wallet OR NOT destination_wallet))
  OR (movement_kind='RETURN' AND (NOT source_wallet OR destination_wallet))
  OR (movement_kind='TRANSFER' AND source_wallet<>destination_wallet)
 THEN RAISE EXCEPTION 'financial transfer movement kind must match its linked wallet locations'; END IF;
 IF (SELECT count(*) FROM posting WHERE organization_id=organization_uuid AND transaction_id=journal.id)<>2
  OR EXISTS(SELECT 1 FROM posting p WHERE p.organization_id=organization_uuid AND p.transaction_id=journal.id
   AND (p.amount<>transfer_amount OR p.currency<>transfer_currency OR p.bucket IS DISTINCT FROM movement_kind
    OR (p.side='DEBIT' AND p.ledger_account_id<>destination_uuid) OR (p.side='CREDIT' AND p.ledger_account_id<>source_uuid)
    OR p.dimensions IS DISTINCT FROM jsonb_build_object('transfer_id',request_uuid::text,'from_account_id',source_uuid::text,
      'to_account_id',destination_uuid::text,'kind',movement_kind,'source','TRANSFER')))
 THEN RAISE EXCEPTION 'financial transfer requires its new exact location movements'; END IF;
END $$;

CREATE FUNCTION app_native_financial_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app_assert_native_financial_transfer(NEW.id,NEW.organization_id);
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER native_financial_transfer_guard AFTER INSERT ON financial_transaction
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_native_financial_transfer_guard();

COMMIT;
