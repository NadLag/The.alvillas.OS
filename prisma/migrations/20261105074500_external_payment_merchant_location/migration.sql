BEGIN;

ALTER TABLE external_payment_capture ADD COLUMN captured_at timestamptz(6);
ALTER TABLE external_payment_capture ADD COLUMN settlement jsonb;

CREATE FUNCTION app_guard_external_capture_time() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.captured_at IS NULL OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL
    AND a.resource_type='financial_transaction' AND a.resource_id=NEW.intent_id AND a.action='finance.external_payment.capture_time_retained'
    AND a.after=jsonb_build_object('intentId',NEW.intent_id,'captureId',NEW.id,'capturedAt',to_char(NEW.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    THEN RAISE EXCEPTION 'actual original provider capture time and audit required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_capture_time_guard AFTER INSERT ON external_payment_capture
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_capture_time();

CREATE FUNCTION app_guard_external_capture_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.settlement IS NULL THEN RETURN NEW; END IF;
  IF NEW.settlement->>'schemaVersion' IS DISTINCT FROM '1' OR NEW.settlement->>'basis' IS DISTINCT FROM 'ORIGINAL_PROVIDER_RECEIVABLE_BREAKDOWN'
    OR NEW.settlement->'gross' IS DISTINCT FROM jsonb_build_object('amount',NEW.amount::text,'currency',NEW.currency)
    OR NEW.settlement->'fee'->>'currency' IS DISTINCT FROM NEW.currency OR NEW.settlement->'net'->>'currency' IS DISTINCT FROM NEW.currency
    OR COALESCE(NEW.settlement->'fee'->>'amount','') !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$'
    OR COALESCE(NEW.settlement->'net'->>'amount','') !~ '^-?(0|[1-9][0-9]*)\.[0-9]{2}$'
    OR (NEW.settlement->'net'->>'amount')::numeric+(NEW.settlement->'fee'->>'amount')::numeric<>NEW.amount
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL AND a.resource_type='financial_transaction'
      AND a.resource_id=NEW.intent_id AND a.action='finance.external_payment.settlement_retained'
      AND a.after=jsonb_build_object('intentId',NEW.intent_id,'captureId',NEW.id,'settlement',NEW.settlement))
    THEN RAISE EXCEPTION 'actual exact provider gross, deductions and net settlement required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_capture_settlement_guard AFTER INSERT ON external_payment_capture
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_capture_settlement();

CREATE FUNCTION app_guard_external_payment_location() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM config_rule r CROSS JOIN LATERAL jsonb_array_elements(r.value->'methods') method
    JOIN ledger_account a ON a.organization_id=NEW.organization_id AND a.id=NEW.account_id
    WHERE r.organization_id=NEW.organization_id AND r.id=NEW.policy_id AND r.version=NEW.policy_version AND r.key='finance.payment_methods'
      AND method->>'key'=NEW.input->'receipt'->>'method' AND method->>'adapter'='paypal'
      AND method->>'provider_account_code'=a.code AND a.account_type='ASSET_LOCATION' AND a.normal_side='DEBIT'
      AND NOT EXISTS(SELECT 1 FROM team_wallet w WHERE w.organization_id=a.organization_id AND w.ledger_account_id=a.id))
    THEN RAISE EXCEPTION 'configured original merchant money location required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_merchant_location_guard AFTER INSERT ON external_payment_intent
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_payment_location();

CREATE FUNCTION app_require_original_external_method() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_intent%ROWTYPE; capture external_payment_capture%ROWTYPE;
BEGIN
  IF NOT NEW.sealed OR NEW.reference NOT LIKE 'GUEST_DEPOSIT:%' THEN RETURN NEW; END IF;
  SELECT * INTO source FROM external_payment_intent WHERE organization_id=NEW.organization_id AND idempotency_key::text=substr(NEW.reference,15);
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO capture FROM external_payment_capture WHERE organization_id=NEW.organization_id AND intent_id=source.id;
  IF capture.id IS NULL OR capture.captured_at IS NULL OR capture.settlement IS NULL OR capture.settlement->'fee'->>'amount' IS DISTINCT FROM '0.00'
    OR NEW.occurred_at IS DISTINCT FROM capture.captured_at OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=NEW.id
    AND a.action='finance.guest_deposit.received' AND a.actor_id=source.requested_by
    AND a.after->'input'->>'paymentMethodFingerprint'=source.input->'receipt'->>'paymentMethodFingerprint')
    THEN RAISE EXCEPTION 'original captured provider method review required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_transaction_external_method_guard AFTER INSERT OR UPDATE ON financial_transaction
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_require_original_external_method();

CREATE FUNCTION app_guard_external_payment_method_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM external_payment_capture c JOIN external_payment_intent i ON i.organization_id=c.organization_id AND i.id=c.intent_id
    JOIN financial_transaction t ON t.organization_id=i.organization_id AND t.id=NEW.resource_id
    JOIN config_rule r ON r.organization_id=i.organization_id AND r.id=i.policy_id
    CROSS JOIN LATERAL jsonb_array_elements(r.value->'methods') method
    WHERE c.organization_id=NEW.organization_id AND c.id::text=NEW.after->>'source' AND NEW.resource_type='financial_transaction'
      AND t.sealed AND t.reference='GUEST_DEPOSIT:'||i.idempotency_key::text AND t.created_by=NEW.actor_id AND NEW.actor_id=i.requested_by
      AND NEW.after->>'schemaVersion'='1' AND NEW.after->>'key'='finance.payment_methods' AND NEW.after->>'adapter'='paypal'
      AND NEW.after->>'policyId'=i.policy_id::text AND NEW.after->>'policyVersion'=i.policy_version::text AND NEW.after->>'methodKey'=i.input->'receipt'->>'method'
      AND NEW.after->'amount'=jsonb_build_object('amount',c.amount::text,'currency',c.currency)
      AND method->>'key'=i.input->'receipt'->>'method' AND NEW.after->'method'=method
      AND COALESCE(NEW.after->>'commandHash','') ~ '^[a-f0-9]{64}$')
    THEN RAISE EXCEPTION 'actual original captured method audit required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_method_audit_guard AFTER INSERT ON audit_log
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN(NEW.action='finance.payment_method.accepted' AND NEW.after->>'sourceNamespace'='PAYPAL_CAPTURE')
EXECUTE FUNCTION app_guard_external_payment_method_audit();

COMMIT;
