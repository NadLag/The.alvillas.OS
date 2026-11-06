BEGIN;

CREATE UNIQUE INDEX external_refund_admission_evidence_once
  ON audit_log(organization_id,resource_id) WHERE action='finance.external_payment.refund_admission_evidence';

CREATE FUNCTION app_assert_external_refund_admission_evidence(organization_uuid uuid,intent_uuid uuid,journal_uuid uuid)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_refund_intent%ROWTYPE; journal record; witness record; latest record; first record; expected jsonb;
BEGIN
  SELECT * INTO source FROM external_payment_refund_intent WHERE organization_id=organization_uuid AND id=intent_uuid;
  SELECT t.*,t.xmin::text AS tuple_xid INTO journal FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.id=journal_uuid;
  SELECT a.*,a.xmin::text AS tuple_xid INTO witness FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction'
    AND a.resource_id=intent_uuid AND a.action='finance.external_payment.refund_admission_evidence';
  SELECT e.*,e.xmin::text AS tuple_xid,s.id AS settlement_id,s.xmin::text AS settlement_xid INTO latest
    FROM external_payment_refund_identity i JOIN external_payment_refund_evidence e ON e.organization_id=i.organization_id AND e.identity_id=i.id
    LEFT JOIN external_payment_refund_settlement s ON s.organization_id=e.organization_id AND s.evidence_id=e.id
    WHERE i.organization_id=organization_uuid AND i.intent_id=intent_uuid ORDER BY e.provider_updated_at DESC,e.id DESC LIMIT 1;
  SELECT e.*,e.xmin::text AS tuple_xid INTO first FROM external_payment_refund_identity i JOIN external_payment_refund_evidence e
    ON e.organization_id=i.organization_id AND e.identity_id=i.id WHERE i.organization_id=organization_uuid AND i.intent_id=intent_uuid AND e.state='COMPLETED'
    ORDER BY e.provider_updated_at,e.id LIMIT 1;
  expected:=jsonb_build_object('schemaVersion',1,'intentId',source.id,'transactionId',journal.id,'originalRequestKey',source.idempotency_key,
    'originalRequestFingerprint',source.request_fingerprint,'originalRequestedBy',source.requested_by,'admittedBy',journal.created_by,
    'evidenceId',latest.id,'settlementId',latest.settlement_id,'firstEvidenceId',first.id,'refundedAt',witness.after->>'refundedAt');
  IF source.id IS NULL OR journal.id IS NULL OR NOT journal.sealed OR witness.id IS NULL OR latest.id IS NULL OR first.id IS NULL
    OR journal.idempotency_key IS DISTINCT FROM 'guest-deposit:'||source.idempotency_key::text
    OR journal.reference IS DISTINCT FROM 'GUEST_DEPOSIT_REFUND:'||source.idempotency_key::text
    OR witness.actor_id IS DISTINCT FROM journal.created_by OR witness.reason IS DISTINCT FROM source.input->'refund'->>'reason'
    OR witness.after IS DISTINCT FROM expected OR (witness.after->>'refundedAt')::timestamptz IS DISTINCT FROM journal.occurred_at
    OR journal.occurred_at IS DISTINCT FROM first.refunded_at OR latest.state IS DISTINCT FROM 'COMPLETED' OR latest.settlement_id IS NULL
    OR journal.tuple_xid IS DISTINCT FROM pg_current_xact_id()::xid::text OR witness.tuple_xid IS DISTINCT FROM journal.tuple_xid
    OR latest.tuple_xid=journal.tuple_xid OR latest.settlement_xid=journal.tuple_xid OR first.tuple_xid=journal.tuple_xid
  THEN RAISE EXCEPTION 'original committed refund admission evidence must be retained atomically with its native journal'; END IF;
END $$;

CREATE FUNCTION app_guard_external_refund_admission_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.action='finance.external_payment.refund_admission_evidence' THEN
    PERFORM app_assert_external_refund_admission_evidence(NEW.organization_id,NEW.resource_id,(NEW.after->>'transactionId')::uuid);
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER audit_external_refund_admission_evidence_guard AFTER INSERT ON audit_log
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_admission_evidence();

CREATE FUNCTION app_guard_external_refund_journal_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source_id uuid;
BEGIN
  IF NOT NEW.sealed THEN RETURN NEW; END IF;
  SELECT id INTO source_id FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND 'guest-deposit:'||idempotency_key::text=NEW.idempotency_key;
  IF source_id IS NOT NULL THEN PERFORM app_assert_external_refund_admission_evidence(NEW.organization_id,source_id,NEW.id); END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_transaction_external_refund_evidence_guard AFTER INSERT OR UPDATE ON financial_transaction
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_journal_evidence();

COMMIT;
