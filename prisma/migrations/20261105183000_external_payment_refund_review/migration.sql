BEGIN;

CREATE FUNCTION app_assert_external_refund_review(tenant uuid,intent uuid,require_prior boolean) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source record; review record; rule config_rule%ROWTYPE;
BEGIN
  SELECT r.*,r.xmin::text AS row_xmin INTO source FROM external_payment_refund_intent r WHERE r.organization_id=tenant AND r.id=intent;
  IF NOT FOUND THEN RAISE EXCEPTION 'original refund source required before retained review'; END IF;
  IF (SELECT count(*) FROM audit_log a WHERE a.organization_id=tenant AND a.resource_type='financial_transaction' AND a.resource_id=intent AND a.action='finance.external_payment.refund_review_retained')<>1
  THEN RAISE EXCEPTION 'one original retained refund policy review required'; END IF;
  SELECT a.*,a.xmin::text AS row_xmin INTO review FROM audit_log a WHERE a.organization_id=tenant AND a.resource_type='financial_transaction' AND a.resource_id=intent AND a.action='finance.external_payment.refund_review_retained';
  SELECT * INTO rule FROM config_rule WHERE organization_id=tenant AND id=(review.after->'policy'->>'id')::uuid;
  IF rule.id IS NULL OR rule.key<>'finance.guest_deposits' OR rule.version::text IS DISTINCT FROM review.after->'policy'->>'version'
    OR rule.value IS DISTINCT FROM review.after->'policy'->'value' OR review.actor_id IS DISTINCT FROM source.requested_by
    OR review.reason IS DISTINCT FROM source.input->'refund'->>'reason' OR review.row_xmin<>source.row_xmin
    OR review.after IS DISTINCT FROM jsonb_build_object('intentId',intent,'reviewFingerprint',source.input->'refund'->>'reviewFingerprint',
      'policy',jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value))
    OR (require_prior AND review.row_xmin=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'exact original committed refund policy review required'; END IF;
END $$;

CREATE FUNCTION app_guard_external_refund_review() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE intent uuid;
BEGIN
  IF TG_TABLE_NAME='external_payment_refund_intent' THEN intent:=NEW.id;
  ELSIF TG_TABLE_NAME='external_payment_refund_attempt' THEN intent:=NEW.intent_id;
  ELSIF TG_TABLE_NAME='audit_log' THEN
    IF NEW.action<>'finance.external_payment.refund_review_retained' THEN RETURN NEW; END IF;
    intent:=NEW.resource_id;
  ELSE
    IF NOT NEW.sealed THEN RETURN NEW; END IF;
    SELECT id INTO intent FROM external_payment_refund_intent WHERE organization_id=NEW.organization_id AND 'guest-deposit:'||idempotency_key::text=NEW.idempotency_key;
    IF intent IS NULL THEN RETURN NEW; END IF;
  END IF;
  PERFORM app_assert_external_refund_review(NEW.organization_id,intent,TG_TABLE_NAME IN('external_payment_refund_attempt','financial_transaction'));
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER external_payment_refund_original_review_guard AFTER INSERT ON external_payment_refund_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_review();
CREATE CONSTRAINT TRIGGER external_payment_refund_prior_review_guard AFTER INSERT ON external_payment_refund_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_review();
CREATE CONSTRAINT TRIGGER audit_log_external_refund_review_guard AFTER INSERT ON audit_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_review();
CREATE CONSTRAINT TRIGGER financial_transaction_external_refund_review_guard AFTER INSERT OR UPDATE ON financial_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_review();

COMMIT;
