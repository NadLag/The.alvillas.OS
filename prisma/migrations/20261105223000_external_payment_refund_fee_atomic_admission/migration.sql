BEGIN;

-- Additive verified-source exceptions; retain all ordinary expense and original capture requirements.

CREATE FUNCTION app_external_refund_fee_economic_at(expense_uuid uuid,organization_uuid uuid) RETURNS timestamptz LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_refund_fee%ROWTYPE; actual_at timestamptz;
BEGIN
  SELECT * INTO f FROM external_payment_refund_fee WHERE organization_id=organization_uuid AND correction_expense_id=expense_uuid;
  IF f.id IS NULL THEN RETURN NULL; END IF;
  PERFORM app_assert_external_refund_fee(f.id,organization_uuid);
  SELECT e.refunded_at INTO actual_at FROM external_payment_refund_identity i JOIN external_payment_refund_evidence e ON e.organization_id=i.organization_id AND e.identity_id=i.id
    WHERE i.organization_id=organization_uuid AND i.intent_id=f.refund_intent_id AND e.state='COMPLETED' ORDER BY e.provider_updated_at,e.id LIMIT 1;
  IF actual_at IS NULL THEN RAISE EXCEPTION 'original independently verified refund economic date required'; END IF;
  RETURN actual_at;
END $$;

CREATE OR REPLACE FUNCTION app_assert_external_payment_fee(fee_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_fee%ROWTYPE; c external_payment_capture%ROWTYPE; i external_payment_intent%ROWTYPE; e expense%ROWTYPE;
BEGIN
  SELECT * INTO f FROM external_payment_fee WHERE organization_id=organization_uuid AND id=fee_uuid;
  SELECT * INTO c FROM external_payment_capture WHERE organization_id=organization_uuid AND id=f.capture_id;
  SELECT * INTO i FROM external_payment_intent WHERE organization_id=organization_uuid AND id=c.intent_id;
  SELECT * INTO e FROM expense WHERE organization_id=organization_uuid AND id=f.expense_id;
  IF f.id IS NULL OR c.id IS NULL OR c.captured_at IS NULL OR c.settlement IS NULL OR i.source_snapshot IS NULL OR e.id IS NULL
    OR e.amount<=0 OR e.amount IS DISTINCT FROM (c.settlement->'fee'->>'amount')::numeric OR e.currency IS DISTINCT FROM c.currency
    OR e.property_id::text IS DISTINCT FROM i.source_snapshot->>'propertyId' OR e.reservation_id IS DISTINCT FROM i.reservation_id
    OR e.funding_account_id IS DISTINCT FROM i.account_id OR e.created_by IS DISTINCT FROM i.requested_by OR f.created_by IS DISTINCT FROM i.requested_by
    OR e.idempotency_key IS DISTINCT FROM c.id OR e.corrects_expense_id IS NOT NULL OR e.emergency OR (e.state='VOIDED' AND NOT EXISTS(SELECT 1 FROM external_payment_refund_fee f_return WHERE f_return.organization_id=organization_uuid AND f_return.original_expense_id=e.id AND app_external_refund_fee_is_posted(f_return.refund_intent_id,organization_uuid)))
    OR e.occurred_on IS DISTINCT FROM (c.captured_at AT TIME ZONE f.property_timezone)::date
    OR EXISTS(SELECT 1 FROM expense_submission s WHERE s.organization_id=organization_uuid AND s.expense_id=e.id AND s.snapshot->>'timezone' IS DISTINCT FROM f.property_timezone)
    OR (e.transaction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.id=e.transaction_id AND t.occurred_at=c.captured_at))
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction' AND a.resource_id=i.id
      AND a.action='finance.external_payment.fee_prepared' AND a.actor_id=f.created_by
      AND a.after=jsonb_build_object('intentId',i.id,'captureId',c.id,'expenseId',e.id,'fee',c.settlement->'fee','propertyTimezone',f.property_timezone))
    THEN RAISE EXCEPTION 'actual original captured fee expense source required'; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_expense_correction_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE corrected expense%ROWTYPE; original_submission expense_submission%ROWTYPE; point timestamptz; actual_refund_at timestamptz;
BEGIN
 IF NEW.reference !~ '^EXPENSE:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
 SELECT * INTO corrected FROM expense WHERE organization_id=NEW.organization_id AND id=substring(NEW.reference FROM 9)::uuid;
 IF corrected.corrects_expense_id IS NULL THEN RETURN NEW; END IF;
 actual_refund_at:=app_external_refund_fee_economic_at(corrected.id,NEW.organization_id);
 IF actual_refund_at IS NOT NULL THEN
  IF NEW.reverses_transaction_id IS NOT NULL OR NEW.idempotency_key IS DISTINCT FROM 'expense:'||corrected.id||':posted' OR NEW.occurred_at IS DISTINCT FROM actual_refund_at
  THEN RAISE EXCEPTION 'provider fee correction must retain its exact verified source and date'; END IF;
  RETURN NEW;
 END IF;
 point:=clock_timestamp();
 SELECT * INTO original_submission FROM expense_submission WHERE organization_id=NEW.organization_id AND expense_id=corrected.corrects_expense_id;
 IF NEW.reverses_transaction_id IS NOT NULL OR NEW.idempotency_key IS DISTINCT FROM 'expense:'||corrected.id||':posted'
  OR NEW.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR NEW.occurred_at>point
  OR original_submission.id IS NULL OR (original_submission.snapshot->>'timezone') IS NULL
  OR date_trunc('month',NEW.occurred_at AT TIME ZONE (original_submission.snapshot->>'timezone')) IS DISTINCT FROM
    date_trunc('month',point AT TIME ZONE (original_submission.snapshot->>'timezone'))
 THEN RAISE EXCEPTION 'expense correction must create a new journal in the current open period'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_expense_correction_link_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal financial_transaction%ROWTYPE; source_timezone text; point timestamptz; actual_refund_at timestamptz;
BEGIN
 IF NEW.corrects_expense_id IS NULL OR NEW.transaction_id IS NULL OR OLD.transaction_id IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id;
 SELECT snapshot->>'timezone' INTO source_timezone FROM expense_submission
  WHERE organization_id=NEW.organization_id AND expense_id=NEW.corrects_expense_id;
 actual_refund_at:=app_external_refund_fee_economic_at(NEW.id,NEW.organization_id);
 IF actual_refund_at IS NOT NULL THEN
  IF journal.id IS NULL OR journal.occurred_at IS DISTINCT FROM actual_refund_at THEN RAISE EXCEPTION 'provider fee correction link requires the exact verified refund date'; END IF;
  RETURN NEW;
 END IF;
 point:=clock_timestamp();
 IF journal.id IS NULL OR source_timezone IS NULL
  OR journal.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR journal.occurred_at>point
  OR date_trunc('month',journal.occurred_at AT TIME ZONE source_timezone) IS DISTINCT FROM date_trunc('month',point AT TIME ZONE source_timezone)
 THEN RAISE EXCEPTION 'expense correction must create a new journal in the current open period'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_guard_external_refund_net_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_refund_intent%ROWTYPE; latest record;
BEGIN
  IF NOT NEW.sealed THEN RETURN NEW; END IF;
  SELECT * INTO source FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND 'guest-deposit:'||idempotency_key::text=NEW.idempotency_key;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT e.state,s.settlement,s.xmin::text AS settlement_xmin INTO latest FROM external_payment_refund_identity i
    JOIN external_payment_refund_evidence e ON e.organization_id=i.organization_id AND e.identity_id=i.id
    LEFT JOIN external_payment_refund_settlement s ON s.organization_id=e.organization_id AND s.evidence_id=e.id
    WHERE i.organization_id=source.organization_id AND i.intent_id=source.id ORDER BY e.provider_updated_at DESC,e.id DESC LIMIT 1;
  IF latest.state IS DISTINCT FROM 'COMPLETED' OR latest.settlement IS NULL OR latest.settlement_xmin=pg_current_xact_id()::xid::text
    OR (latest.settlement->'net'->>'amount')::numeric IS DISTINCT FROM source.amount-(latest.settlement->'fee'->>'amount')::numeric
    OR ((latest.settlement->'fee'->>'amount')::numeric>0 AND NOT app_external_refund_fee_is_posted(source.id,source.organization_id))
  THEN RAISE EXCEPTION 'committed exact refund net and supported native fee treatment required'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app_guard_external_refund_fee_offset() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_refund_fee%ROWTYPE; r external_payment_refund_intent%ROWTYPE; expense_uuid uuid;
BEGIN
  IF NOT NEW.sealed OR NEW.reference !~ '^EXPENSE:[0-9a-f-]{36}(:VOID)?$' THEN RETURN NEW; END IF;
  expense_uuid:=substring(NEW.reference FROM 9 FOR 36)::uuid;
  FOR f IN SELECT * FROM external_payment_refund_fee WHERE organization_id=NEW.organization_id
    AND ((original_expense_id=expense_uuid AND NEW.reverses_transaction_id IS NOT NULL) OR (correction_expense_id=expense_uuid AND NEW.reverses_transaction_id IS NULL)) LOOP
    SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND id=f.refund_intent_id;
    IF NOT app_external_refund_fee_is_posted(r.id,NEW.organization_id) OR NOT EXISTS(SELECT 1 FROM audit_log a
      WHERE a.organization_id=NEW.organization_id AND a.resource_type='expense' AND a.resource_id=expense_uuid AND a.actor_id=r.requested_by
      AND a.action=CASE WHEN NEW.reverses_transaction_id IS NULL THEN 'expense.posted' ELSE 'expense.voided' END
      AND a.reason=r.input#>>'{refund,reason}')
    THEN RAISE EXCEPTION 'verified fee offset and original gross guest refund must be admitted atomically with their attributed reasons'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_transaction_external_refund_fee_offset_guard AFTER INSERT OR UPDATE ON financial_transaction
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_fee_offset();

COMMIT;
