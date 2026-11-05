BEGIN;

CREATE UNIQUE INDEX audit_external_refund_supervised_review_unique
  ON audit_log(organization_id,(after->>'reviewId')) WHERE action='finance.external_payment.refund_supervised_admission_reviewed';
CREATE UNIQUE INDEX audit_external_refund_supervised_admission_unique
  ON audit_log(organization_id,resource_id) WHERE action='finance.external_payment.refund_supervised_admitted';
CREATE UNIQUE INDEX audit_external_refund_supervised_command_unique
  ON audit_log(organization_id,actor_id,(after->>'commandKey')) WHERE action='finance.external_payment.refund_supervised_admitted';

-- The original requester remains immutable. A distinct actual writer requires a committed independent
-- review plus authorization, final audit and canonical journal all in the same transaction.
CREATE FUNCTION app_external_refund_admission_actor(refund_uuid uuid,organization_uuid uuid,journal_uuid uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r external_payment_refund_intent%ROWTYPE; journal record; final record; permission_witness record; review record; first record; latest record; expected jsonb;
BEGIN
  SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=organization_uuid AND id=refund_uuid;
  SELECT t.*,t.xmin::text AS tuple_xid INTO journal FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.id=journal_uuid;
  IF r.id IS NULL OR journal.id IS NULL OR journal.idempotency_key IS DISTINCT FROM 'guest-deposit:'||r.idempotency_key::text THEN RETURN NULL; END IF;
  IF journal.created_by=r.requested_by THEN RETURN r.requested_by; END IF;
  SELECT a.*,a.xmin::text AS tuple_xid INTO final FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction'
    AND a.resource_id=r.id AND a.actor_id=journal.created_by AND a.action='finance.external_payment.refund_supervised_admitted';
  IF final.id IS NULL OR final.tuple_xid IS DISTINCT FROM journal.tuple_xid OR length(coalesce(final.reason,'')) NOT BETWEEN 6 AND 500 THEN RETURN NULL; END IF;
  expected:=jsonb_build_object('reviewId',final.after->'reviewId','reviewFingerprint',final.after->'reviewFingerprint','intentId',r.id,'commandKey',final.after->'commandKey',
    'originalRequestedBy',r.requested_by,'admittedBy',journal.created_by,'originalRequestKey',r.idempotency_key,'transactionId',journal.id);
  IF final.after IS DISTINCT FROM expected OR coalesce(final.after->>'commandKey','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  SELECT a.*,a.xmin::text AS tuple_xid INTO permission_witness FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction'
    AND a.resource_id=r.id AND a.actor_id=journal.created_by AND a.action='finance.external_payment.refund_supervised_authorized'
    AND a.after=final.after-'transactionId' AND a.reason=final.reason AND a.xmin::text=journal.tuple_xid;
  SELECT a.*,a.xmin::text AS tuple_xid INTO review FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction'
    AND a.resource_id=r.id AND a.actor_id=journal.created_by AND a.action='finance.external_payment.refund_supervised_admission_reviewed'
    AND a.after->>'reviewId'=final.after->>'reviewId' AND a.reason=final.reason;
  IF permission_witness.id IS NULL OR review.id IS NULL OR review.tuple_xid=journal.tuple_xid
    OR review.after->>'schemaVersion' IS DISTINCT FROM '1' OR review.after->>'intentId' IS DISTINCT FROM r.id::text
    OR review.after->>'reviewFingerprint' IS DISTINCT FROM final.after->>'reviewFingerprint'
    OR coalesce(review.after->>'reviewFingerprint','') !~ '^[a-f0-9]{64}$' OR coalesce(review.after->>'sourceFingerprint','') !~ '^[a-f0-9]{64}$'
    OR coalesce(review.after->>'guestRefundFingerprint','') !~ '^[a-f0-9]{64}$' OR review.after->>'reason' IS DISTINCT FROM final.reason
    OR review.after->>'originalRequestedBy' IS DISTINCT FROM r.requested_by::text OR review.after->>'originalRequestKey' IS DISTINCT FROM r.idempotency_key::text
    OR review.after->>'originalRequestFingerprint' IS DISTINCT FROM r.request_fingerprint
    OR review.after#>>'{authorizationCap,schemaVersion}' IS DISTINCT FROM '1'
    OR review.after#>>'{authorizationCap,organizationId}' IS DISTINCT FROM organization_uuid::text
    OR review.after#>>'{authorizationCap,userAccountId}' IS DISTINCT FROM journal.created_by::text
  THEN RETURN NULL; END IF;
  SELECT e.*,e.xmin::text AS tuple_xid INTO first FROM external_payment_refund_identity i JOIN external_payment_refund_evidence e
    ON e.organization_id=i.organization_id AND e.identity_id=i.id WHERE i.organization_id=organization_uuid AND i.intent_id=r.id AND e.state='COMPLETED'
    ORDER BY e.provider_updated_at,e.id LIMIT 1;
  SELECT e.state,s.id AS settlement_id,s.settlement,e.xmin::text AS evidence_xid,s.xmin::text AS settlement_xid INTO latest FROM external_payment_refund_identity i
    JOIN external_payment_refund_evidence e ON e.organization_id=i.organization_id AND e.identity_id=i.id
    LEFT JOIN external_payment_refund_settlement s ON s.organization_id=e.organization_id AND s.evidence_id=e.id
    WHERE i.organization_id=organization_uuid AND i.intent_id=r.id ORDER BY e.provider_updated_at DESC,e.id DESC LIMIT 1;
  IF first.id IS NULL OR first.tuple_xid=journal.tuple_xid OR latest.state IS DISTINCT FROM 'COMPLETED' OR latest.settlement_id IS NULL
    OR latest.evidence_xid=journal.tuple_xid OR latest.settlement_xid=journal.tuple_xid
    OR (latest.settlement->'fee'->>'amount')::numeric IS DISTINCT FROM 0::numeric
    OR review.after->>'firstEvidenceId' IS DISTINCT FROM first.id::text OR review.after->>'settlementId' IS DISTINCT FROM latest.settlement_id::text
    OR (review.after->>'refundedAt')::timestamptz IS DISTINCT FROM first.refunded_at OR journal.occurred_at IS DISTINCT FROM first.refunded_at
  THEN RETURN NULL; END IF;
  RETURN journal.created_by;
END $$;

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
  IF actual.id IS NULL OR NEW.created_by IS DISTINCT FROM app_external_refund_admission_actor(source.id,NEW.organization_id,NEW.id) OR NEW.occurred_at IS DISTINCT FROM actual.refunded_at
    OR NEW.reference IS DISTINCT FROM 'GUEST_DEPOSIT_REFUND:'||source.idempotency_key::text
    OR saved->'input'->>'externalReference' IS DISTINCT FROM actual.refund_id
    OR ((saved->'input')-'reviewFingerprint'-'externalReference') IS DISTINCT FROM ((source.input->'refund')-'reviewFingerprint'-'externalReference')
  THEN RAISE EXCEPTION 'committed verified provider refund required for original native admission'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app_guard_external_refund_supervision_witness() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r external_payment_refund_intent%ROWTYPE; journal record;
BEGIN
  IF NEW.action NOT IN ('finance.external_payment.refund_supervised_authorized','finance.external_payment.refund_supervised_admitted') THEN RETURN NEW; END IF;
  SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND id=NEW.resource_id;
  SELECT t.*,t.xmin::text AS tuple_xid INTO journal FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.idempotency_key='guest-deposit:'||r.idempotency_key::text;
  IF NEW.resource_type IS DISTINCT FROM 'financial_transaction' OR r.id IS NULL OR journal.id IS NULL OR NEW.actor_id IS NOT DISTINCT FROM r.requested_by
    OR journal.tuple_xid IS DISTINCT FROM NEW.xmin::text OR NEW.actor_id IS DISTINCT FROM app_external_refund_admission_actor(r.id,NEW.organization_id,journal.id)
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_id=r.id AND a.actor_id=NEW.actor_id
      AND a.action='finance.external_payment.refund_supervised_admitted' AND a.reason=NEW.reason AND a.after->>'commandKey'=NEW.after->>'commandKey'
      AND a.after->>'reviewId'=NEW.after->>'reviewId' AND a.xmin::text=NEW.xmin::text)
  THEN RAISE EXCEPTION 'supervised refund authorization, final witness and original native admission must commit atomically'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER audit_external_refund_supervision_native_guard AFTER INSERT ON audit_log
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_supervision_witness();

COMMIT;
