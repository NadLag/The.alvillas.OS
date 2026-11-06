BEGIN;

CREATE FUNCTION app_lock_external_refund_fee_source() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r external_payment_refund_intent%ROWTYPE;
BEGIN
  SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND id=NEW.refund_intent_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'original fee return source required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':financial-transfer:guest-deposit-source:'||r.deposit_id::text,0));
  IF EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=NEW.organization_id AND idempotency_key='guest-deposit:'||r.idempotency_key::text)
  THEN RAISE EXCEPTION 'fee plan must precede its original guest refund admission'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_payment_refund_fee_source_lock BEFORE INSERT ON external_payment_refund_fee
FOR EACH ROW EXECUTE FUNCTION app_lock_external_refund_fee_source();

-- Every new native cost offset and the original gross guest refund belong to one transaction.
CREATE OR REPLACE FUNCTION app_guard_external_refund_fee_offset() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_refund_fee%ROWTYPE; r external_payment_refund_intent%ROWTYPE; expense_uuid uuid;
BEGIN
  IF NOT NEW.sealed OR NEW.reference !~ '^EXPENSE:[0-9a-f-]{36}(:VOID)?$' THEN RETURN NEW; END IF;
  expense_uuid:=substring(NEW.reference FROM 9 FOR 36)::uuid;
  FOR f IN SELECT * FROM external_payment_refund_fee WHERE organization_id=NEW.organization_id
    AND ((original_expense_id=expense_uuid AND NEW.reverses_transaction_id IS NOT NULL) OR (correction_expense_id=expense_uuid AND NEW.reverses_transaction_id IS NULL)) LOOP
    SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND id=f.refund_intent_id;
    IF NOT EXISTS(SELECT 1 FROM expense e JOIN financial_transaction t ON t.organization_id=e.organization_id AND t.reverses_transaction_id=e.transaction_id
      WHERE e.organization_id=f.organization_id AND e.id=f.original_expense_id AND t.xmin::text=pg_current_xact_id()::xid::text)
      OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=f.organization_id AND t.idempotency_key='guest-deposit:'||r.idempotency_key::text AND t.xmin::text=pg_current_xact_id()::xid::text)
      OR (f.correction_expense_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM expense e JOIN financial_transaction t ON t.organization_id=e.organization_id AND t.id=e.transaction_id
        WHERE e.organization_id=f.organization_id AND e.id=f.correction_expense_id AND t.xmin::text=pg_current_xact_id()::xid::text))
      OR NOT app_external_refund_fee_is_posted(r.id,NEW.organization_id) OR NOT EXISTS(SELECT 1 FROM audit_log a
      WHERE a.organization_id=NEW.organization_id AND a.resource_type='expense' AND a.resource_id=expense_uuid AND a.actor_id=r.requested_by
      AND a.action=CASE WHEN NEW.reverses_transaction_id IS NULL THEN 'expense.posted' ELSE 'expense.voided' END
      AND a.reason=r.input#>>'{refund,reason}')
    THEN RAISE EXCEPTION 'verified fee offset and original gross guest refund must be admitted atomically with their attributed reasons'; END IF;
  END LOOP;
  RETURN NEW;
END $$;

COMMIT;
