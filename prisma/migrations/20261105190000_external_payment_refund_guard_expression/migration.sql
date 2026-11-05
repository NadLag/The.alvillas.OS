BEGIN;

-- Retain every original source check; group JSON extraction before key subtraction.
CREATE OR REPLACE FUNCTION app_guard_external_refund_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_refund_intent%ROWTYPE; actual record; saved jsonb;
BEGIN
  IF NEW.reverses_transaction_id IS NOT NULL AND EXISTS(SELECT 1 FROM financial_transaction t JOIN external_payment_refund_intent r ON r.organization_id=t.organization_id
    AND t.idempotency_key='guest-deposit:'||r.idempotency_key::text WHERE t.organization_id=NEW.organization_id AND t.id=NEW.reverses_transaction_id)
  THEN RAISE EXCEPTION 'verified provider refunds require attributed actual corrective money movements'; END IF;
  IF NOT NEW.sealed THEN RETURN NEW; END IF;
  SELECT a.after INTO saved FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=NEW.id AND a.action='finance.guest_deposit.refunded';
  SELECT * INTO source FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND 'guest-deposit:'||idempotency_key::text=NEW.idempotency_key;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM external_payment_capture c JOIN external_payment_intent i ON i.organization_id=c.organization_id AND i.id=c.intent_id
      WHERE i.organization_id=NEW.organization_id AND i.idempotency_key::text=saved->'input'->>'depositId' AND i.account_id::text=saved->'input'->>'accountId')
    THEN RAISE EXCEPTION 'actual provider merchant refund requires verified durable source'; END IF;
    RETURN NEW;
  END IF;
  SELECT e.*,i.refund_id INTO actual FROM external_payment_refund_identity i JOIN external_payment_refund_evidence e ON e.organization_id=i.organization_id AND e.identity_id=i.id
    WHERE i.organization_id=source.organization_id AND i.intent_id=source.id AND e.state='COMPLETED' AND e.xmin::text<>pg_current_xact_id()::xid::text ORDER BY e.provider_updated_at,e.id LIMIT 1;
  IF actual.id IS NULL OR NEW.created_by IS DISTINCT FROM source.requested_by OR NEW.occurred_at IS DISTINCT FROM actual.refunded_at
    OR NEW.reference IS DISTINCT FROM 'GUEST_DEPOSIT_REFUND:'||source.idempotency_key::text
    OR saved->'input'->>'externalReference' IS DISTINCT FROM actual.refund_id
    OR ((saved->'input')-'reviewFingerprint'-'externalReference') IS DISTINCT FROM ((source.input->'refund')-'reviewFingerprint'-'externalReference')
  THEN RAISE EXCEPTION 'committed verified provider refund required for original native admission'; END IF;
  RETURN NEW;
END $$;

COMMIT;
