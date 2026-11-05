BEGIN;

-- Keep all original financial invariants; replace only actor equality with independently committed, attributed supervision.

CREATE FUNCTION app_external_refund_fee_preparer_valid(binding_uuid uuid,organization_uuid uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f record; r external_payment_refund_intent%ROWTYPE; witness record; review record; expected jsonb;
BEGIN
  SELECT t.*,t.xmin::text AS tuple_xid INTO f FROM external_payment_refund_fee t WHERE t.organization_id=organization_uuid AND t.id=binding_uuid;
  SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=organization_uuid AND id=f.refund_intent_id;
  IF f.id IS NULL OR r.id IS NULL OR f.created_by=r.requested_by THEN RETURN false; END IF;
  SELECT a.*,a.xmin::text AS tuple_xid INTO witness FROM audit_log a WHERE a.organization_id=organization_uuid AND a.actor_id=f.created_by
    AND a.resource_type='financial_transaction' AND a.resource_id=r.id AND a.action='finance.external_payment.refund_fee_supervised_prepared'
    AND a.after->>'bindingId'=f.id::text AND a.xmin::text=f.tuple_xid;
  IF witness.id IS NULL OR length(coalesce(witness.reason,'')) NOT BETWEEN 6 AND 500 THEN RETURN false; END IF;
  expected:=jsonb_build_object('intentId',r.id,'bindingId',f.id,'reviewId',witness.after->'reviewId','reviewFingerprint',witness.after->'reviewFingerprint',
    'originalRequestedBy',r.requested_by,'preparedBy',f.created_by);
  IF witness.after IS DISTINCT FROM expected THEN RETURN false; END IF;
  SELECT a.*,a.xmin::text AS tuple_xid INTO review FROM audit_log a WHERE a.organization_id=organization_uuid AND a.actor_id=f.created_by
    AND a.resource_type='financial_transaction' AND a.resource_id=r.id AND a.action='finance.external_payment.refund_supervision_reviewed'
    AND a.after->>'reviewId'=witness.after->>'reviewId' AND a.reason=witness.reason;
  IF review.id IS NULL OR review.tuple_xid=f.tuple_xid OR review.after->>'reason' IS DISTINCT FROM witness.reason
    OR review.after->>'reviewFingerprint' IS DISTINCT FROM witness.after->>'reviewFingerprint' OR coalesce(review.after->>'reviewFingerprint','') !~ '^[a-f0-9]{64}$'
    OR review.after#>>'{authorizationCap,organizationId}' IS DISTINCT FROM organization_uuid::text OR review.after#>>'{authorizationCap,userAccountId}' IS DISTINCT FROM f.created_by::text
    OR review.after#>>'{basis,intentId}' IS DISTINCT FROM r.id::text OR review.after#>>'{basis,originalRequestedBy}' IS DISTINCT FROM r.requested_by::text
    OR review.after#>>'{basis,prospectiveAdmitter}' IS DISTINCT FROM f.created_by::text OR review.after#>>'{basis,originalRequestFingerprint}' IS DISTINCT FROM r.request_fingerprint
    OR review.after#>>'{basis,originalRequestKey}' IS DISTINCT FROM r.idempotency_key::text OR review.after#>>'{basis,captureId}' IS DISTINCT FROM r.capture_id::text
    OR review.after#>>'{basis,depositId}' IS DISTINCT FROM r.deposit_id::text
  THEN RETURN false; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app_external_refund_admission_actor(refund_uuid uuid,organization_uuid uuid,journal_uuid uuid) RETURNS uuid
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
    OR review.after->>'firstEvidenceId' IS DISTINCT FROM first.id::text OR review.after->>'settlementId' IS DISTINCT FROM latest.settlement_id::text
    OR (review.after->>'refundedAt')::timestamptz IS DISTINCT FROM first.refunded_at OR journal.occurred_at IS DISTINCT FROM first.refunded_at
  THEN RETURN NULL; END IF;
  RETURN journal.created_by;
END $$;

CREATE OR REPLACE FUNCTION app_assert_external_refund_fee(binding_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_refund_fee%ROWTYPE; r external_payment_refund_intent%ROWTYPE; root external_payment_fee%ROWTYPE;
  old_cost expense%ROWTYPE; correction expense%ROWTYPE; observation record;
BEGIN
  SELECT * INTO f FROM external_payment_refund_fee WHERE organization_id=organization_uuid AND id=binding_uuid;
  SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=organization_uuid AND id=f.refund_intent_id;
  SELECT * INTO root FROM external_payment_fee WHERE organization_id=organization_uuid AND capture_id=f.capture_id;
  SELECT * INTO old_cost FROM expense WHERE organization_id=organization_uuid AND id=f.original_expense_id;
  SELECT * INTO correction FROM expense WHERE organization_id=organization_uuid AND id=f.correction_expense_id;
  SELECT e.state,e.refunded_at,s.settlement,e.xmin::text AS evidence_xmin,s.xmin::text AS settlement_xmin INTO observation
    FROM external_payment_refund_identity i JOIN external_payment_refund_evidence e ON e.organization_id=i.organization_id AND e.identity_id=i.id
    LEFT JOIN external_payment_refund_settlement s ON s.organization_id=e.organization_id AND s.evidence_id=e.id
    WHERE i.organization_id=organization_uuid AND i.intent_id=r.id ORDER BY e.provider_updated_at DESC,e.id DESC LIMIT 1;
  IF f.id IS NULL OR r.id IS NULL OR root.id IS NULL OR old_cost.id IS NULL OR old_cost.transaction_id IS NULL
    OR r.capture_id IS DISTINCT FROM f.capture_id OR (r.requested_by IS DISTINCT FROM f.created_by AND NOT app_external_refund_fee_preparer_valid(f.id,organization_uuid)) OR r.currency IS DISTINCT FROM f.currency
    OR old_cost.currency IS DISTINCT FROM f.currency OR old_cost.amount IS DISTINCT FROM f.current_cost OR root.property_timezone IS DISTINCT FROM f.property_timezone
    OR old_cost.state NOT IN ('POSTED','VOIDED') OR old_cost.version IS DISTINCT FROM (f.original_expense_version+CASE WHEN old_cost.state='VOIDED' THEN 1 ELSE 0 END)
    OR f.current_cost>(SELECT amount FROM expense WHERE organization_id=organization_uuid AND id=root.expense_id)
    OR observation.state IS DISTINCT FROM 'COMPLETED' OR observation.refunded_at IS NULL OR observation.settlement IS NULL
    OR observation.evidence_xmin=pg_current_xact_id()::xid::text OR observation.settlement_xmin=pg_current_xact_id()::xid::text
    OR (observation.settlement#>>'{gross,amount}')::numeric IS DISTINCT FROM r.amount OR observation.settlement#>>'{gross,currency}' IS DISTINCT FROM f.currency
    OR (observation.settlement#>>'{fee,amount}')::numeric IS DISTINCT FROM f.returned_fee OR observation.settlement#>>'{fee,currency}' IS DISTINCT FROM f.currency
    OR (observation.settlement#>>'{net,amount}')::numeric IS DISTINCT FROM r.amount-f.returned_fee OR observation.settlement#>>'{net,currency}' IS DISTINCT FROM f.currency
    OR EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction' AND a.resource_id=r.id AND a.action='finance.external_payment.refund_cancelled_before_attempt')
    OR NOT EXISTS(SELECT 1 FROM expense_submission s WHERE s.organization_id=organization_uuid AND s.expense_id=old_cost.id AND s.snapshot->>'timezone'=f.property_timezone)
    OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.id=old_cost.transaction_id AND t.sealed)
    OR (old_cost.id<>root.expense_id AND NOT EXISTS(SELECT 1 FROM external_payment_refund_fee previous
      JOIN financial_transaction admitted ON admitted.organization_id=previous.organization_id AND admitted.idempotency_key='guest-deposit:'||(SELECT idempotency_key::text FROM external_payment_refund_intent WHERE organization_id=organization_uuid AND id=previous.refund_intent_id)
      WHERE previous.organization_id=organization_uuid AND previous.capture_id=f.capture_id AND previous.correction_expense_id=old_cost.id
      AND previous.xmin::text<>pg_current_xact_id()::xid::text AND admitted.sealed AND admitted.xmin::text<>pg_current_xact_id()::xid::text))
    OR (f.remaining_cost>0 AND (correction.id IS NULL OR correction.corrects_expense_id IS DISTINCT FROM old_cost.id
      OR correction.corrects_expense_version IS DISTINCT FROM f.original_expense_version OR correction.amount IS DISTINCT FROM f.remaining_cost
      OR correction.currency IS DISTINCT FROM f.currency OR correction.created_by IS DISTINCT FROM f.created_by OR correction.idempotency_key IS DISTINCT FROM r.id))
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction' AND a.resource_id=r.id
      AND a.actor_id=f.created_by AND a.action='finance.external_payment.refund_fee_prepared' AND a.reason=r.input#>>'{refund,reason}'
      AND a.after=jsonb_build_object('intentId',r.id,'bindingId',f.id,'captureId',f.capture_id,'originalExpenseId',old_cost.id,'originalExpenseVersion',f.original_expense_version,
        'correctionExpenseId',f.correction_expense_id,'currentCost',jsonb_build_object('amount',f.current_cost::text,'currency',f.currency),
        'returnedFee',jsonb_build_object('amount',f.returned_fee::text,'currency',f.currency),'remainingCost',jsonb_build_object('amount',f.remaining_cost::text,'currency',f.currency),'propertyTimezone',f.property_timezone))
  THEN RAISE EXCEPTION 'committed original refund fee and immutable native correction provenance required'; END IF;
  PERFORM app_assert_expense_posting(old_cost.id,organization_uuid);
  IF f.correction_expense_id IS NOT NULL THEN PERFORM app_assert_expense_correction(f.correction_expense_id,organization_uuid); END IF;
END $$;

CREATE OR REPLACE FUNCTION app_external_refund_fee_is_posted(refund_uuid uuid,organization_uuid uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_refund_fee%ROWTYPE; r external_payment_refund_intent%ROWTYPE; e expense%ROWTYPE; replacement expense%ROWTYPE;
  reversal financial_transaction%ROWTYPE; admitted financial_transaction%ROWTYPE; actual_at timestamptz; reversal_current boolean; admitted_current boolean; actual_actor uuid;
BEGIN
  SELECT * INTO f FROM external_payment_refund_fee WHERE organization_id=organization_uuid AND refund_intent_id=refund_uuid;
  IF f.id IS NULL THEN RETURN false; END IF;
  PERFORM app_assert_external_refund_fee(f.id,organization_uuid);
  SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=organization_uuid AND id=refund_uuid;
  SELECT * INTO e FROM expense WHERE organization_id=organization_uuid AND id=f.original_expense_id;
  SELECT * INTO replacement FROM expense WHERE organization_id=organization_uuid AND id=f.correction_expense_id;
  SELECT t.* INTO reversal FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.reverses_transaction_id=e.transaction_id;
  SELECT xmin::text=pg_current_xact_id()::xid::text INTO reversal_current FROM financial_transaction WHERE organization_id=organization_uuid AND id=reversal.id;
  SELECT t.* INTO admitted FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.idempotency_key='guest-deposit:'||r.idempotency_key;
  SELECT xmin::text=pg_current_xact_id()::xid::text INTO admitted_current FROM financial_transaction WHERE organization_id=organization_uuid AND id=admitted.id;
  SELECT observation.refunded_at INTO actual_at FROM external_payment_refund_identity identity
    JOIN external_payment_refund_evidence observation ON observation.organization_id=identity.organization_id AND observation.identity_id=identity.id
    WHERE identity.organization_id=organization_uuid AND identity.intent_id=r.id AND observation.state='COMPLETED'
    ORDER BY observation.provider_updated_at,observation.id LIMIT 1;
  actual_actor:=app_external_refund_admission_actor(r.id,organization_uuid,admitted.id);
  IF actual_actor IS NULL OR e.state IS DISTINCT FROM 'VOIDED' OR e.version IS DISTINCT FROM f.original_expense_version+1 OR reversal.id IS NULL OR (NOT reversal.sealed AND reversal_current IS DISTINCT FROM true)
    OR reversal.created_by IS DISTINCT FROM actual_actor OR reversal.occurred_at IS DISTINCT FROM actual_at
    OR admitted.id IS NULL OR (NOT admitted.sealed AND admitted_current IS DISTINCT FROM true) OR admitted.created_by IS DISTINCT FROM actual_actor OR admitted.occurred_at IS DISTINCT FROM actual_at
    OR (f.remaining_cost>0 AND (replacement.id IS NULL OR replacement.transaction_id IS NULL OR replacement.state NOT IN ('POSTED','VOIDED')
      OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.id=replacement.transaction_id
        AND (t.sealed OR t.xmin::text=pg_current_xact_id()::xid::text) AND t.created_by=actual_actor AND t.occurred_at=actual_at)))
    THEN RETURN false; END IF;
  IF replacement.id IS NOT NULL THEN PERFORM app_assert_expense_posting(replacement.id,organization_uuid); END IF;
  RETURN true;
END $$;

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
      WHERE a.organization_id=NEW.organization_id AND a.resource_type='expense' AND a.resource_id=expense_uuid AND a.actor_id=app_external_refund_admission_actor(r.id,NEW.organization_id,(SELECT id FROM financial_transaction WHERE organization_id=NEW.organization_id AND idempotency_key='guest-deposit:'||r.idempotency_key::text))
      AND a.action=CASE WHEN NEW.reverses_transaction_id IS NULL THEN 'expense.posted' ELSE 'expense.voided' END
      AND a.reason=r.input#>>'{refund,reason}')
    THEN RAISE EXCEPTION 'verified fee offset and original gross guest refund must be admitted atomically with their attributed reasons'; END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE FUNCTION app_guard_external_refund_fee_supervision_witness() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.action='finance.external_payment.refund_fee_supervised_prepared' AND (NEW.resource_type IS DISTINCT FROM 'financial_transaction'
    OR NOT EXISTS(SELECT 1 FROM external_payment_refund_fee f WHERE f.organization_id=NEW.organization_id AND f.id::text=NEW.after->>'bindingId'
      AND f.refund_intent_id=NEW.resource_id AND f.created_by=NEW.actor_id AND f.xmin::text=NEW.xmin::text AND app_external_refund_fee_preparer_valid(f.id,NEW.organization_id)))
  THEN RAISE EXCEPTION 'supervised fee preparation requires its original source, committed independent review and same-transaction binding'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER audit_external_refund_fee_supervision_native_guard AFTER INSERT ON audit_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_fee_supervision_witness();

COMMIT;

