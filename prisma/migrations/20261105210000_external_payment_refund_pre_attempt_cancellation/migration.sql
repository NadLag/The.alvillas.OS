BEGIN;

-- Cancellation releases an existing reservation only before any external-money
-- attempt. The intent, outbox and attributed audit remain append-only.
CREATE UNIQUE INDEX external_refund_one_pre_attempt_cancellation
ON audit_log(organization_id,resource_id)
WHERE action='finance.external_payment.refund_cancelled_before_attempt' AND resource_type='financial_transaction';

CREATE FUNCTION app_guard_external_refund_cancellation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original external_payment_refund_intent%ROWTYPE;
BEGIN
  SELECT * INTO original FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND id=NEW.resource_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'original refund intent required for cancellation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':financial-transfer:guest-deposit-source:'||original.deposit_id::text,0));
  IF EXISTS(SELECT 1 FROM external_payment_refund_intent r WHERE r.organization_id=original.organization_id AND r.id=original.id AND r.xmin::text=pg_current_xact_id()::xid::text)
    OR NEW.actor_id IS DISTINCT FROM original.requested_by OR NEW.resource_type<>'financial_transaction'
    OR NEW.reason IS NULL OR length(btrim(NEW.reason)) NOT BETWEEN 6 AND 500
    OR NEW.after IS DISTINCT FROM jsonb_build_object('intentId',original.id,'captureId',original.capture_id,'depositId',original.deposit_id,
      'idempotencyKey',original.idempotency_key,'amount',jsonb_build_object('amount',original.amount::text,'currency',original.currency),'disposition','CANCELLED_BEFORE_PROVIDER_ATTEMPT')
    OR EXISTS(SELECT 1 FROM external_payment_refund_attempt a WHERE a.organization_id=original.organization_id AND a.intent_id=original.id)
    OR EXISTS(SELECT 1 FROM external_payment_refund_identity i WHERE i.organization_id=original.organization_id AND i.intent_id=original.id)
    OR EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=original.organization_id AND t.idempotency_key='guest-deposit:'||original.idempotency_key::text)
  THEN RAISE EXCEPTION 'refund cancellation requires original unattempted durable source and attributed audit'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_external_refund_cancellation_guard BEFORE INSERT ON audit_log
FOR EACH ROW WHEN(NEW.action='finance.external_payment.refund_cancelled_before_attempt') EXECUTE FUNCTION app_guard_external_refund_cancellation();

CREATE FUNCTION app_guard_external_refund_uncancelled_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original external_payment_refund_intent%ROWTYPE;
BEGIN
  SELECT * INTO original FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND id=NEW.intent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'original refund intent required before provider attempt'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':financial-transfer:guest-deposit-source:'||original.deposit_id::text,0));
  IF EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='financial_transaction'
    AND a.resource_id=original.id AND a.action='finance.external_payment.refund_cancelled_before_attempt')
  THEN RAISE EXCEPTION 'cancelled original refund cannot start a provider attempt'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_refund_uncancelled_attempt_guard BEFORE INSERT ON external_payment_refund_attempt
FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_uncancelled_attempt();

CREATE OR REPLACE FUNCTION app_external_refund_reserved(tenant uuid,deposit uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(sum(r.amount),0) FROM external_payment_refund_intent r
 WHERE r.organization_id=tenant AND r.deposit_id=deposit AND NOT EXISTS(
   SELECT 1 FROM financial_transaction t WHERE t.organization_id=r.organization_id
   AND t.idempotency_key='guest-deposit:'||r.idempotency_key::text AND t.reference='GUEST_DEPOSIT_REFUND:'||r.idempotency_key::text AND t.sealed)
 AND NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=r.organization_id AND a.resource_type='financial_transaction'
   AND a.resource_id=r.id AND a.action='finance.external_payment.refund_cancelled_before_attempt')
$$;

COMMIT;
