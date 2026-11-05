BEGIN;

-- Source metadata only. The existing expense, approval and sealed journal guards remain authoritative.
CREATE TABLE external_payment_fee (
  id uuid NOT NULL DEFAULT app_uuid_v7(), organization_id uuid NOT NULL, capture_id uuid NOT NULL,
  expense_id uuid NOT NULL, created_by uuid NOT NULL, property_timezone text NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT external_payment_fee_pkey PRIMARY KEY(id),
  CONSTRAINT external_payment_fee_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_payment_fee_organization_id_capture_id_fkey FOREIGN KEY(organization_id,capture_id) REFERENCES external_payment_capture(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_payment_fee_organization_id_expense_id_fkey FOREIGN KEY(organization_id,expense_id) REFERENCES expense(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_payment_fee_organization_id_created_by_fkey FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX external_payment_fee_org_id_unique ON external_payment_fee(organization_id,id);
CREATE UNIQUE INDEX external_payment_fee_capture_unique ON external_payment_fee(organization_id,capture_id);
CREATE UNIQUE INDEX external_payment_fee_expense_unique ON external_payment_fee(organization_id,expense_id);
ALTER TABLE external_payment_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_payment_fee FORCE ROW LEVEL SECURITY;
CREATE POLICY external_payment_fee_tenant_isolation ON external_payment_fee
USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER external_payment_fee_no_update BEFORE UPDATE ON external_payment_fee FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER external_payment_fee_no_delete BEFORE DELETE ON external_payment_fee FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_assert_external_payment_fee(fee_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
    OR e.idempotency_key IS DISTINCT FROM c.id OR e.corrects_expense_id IS NOT NULL OR e.emergency OR e.state='VOIDED'
    OR e.occurred_on IS DISTINCT FROM (c.captured_at AT TIME ZONE f.property_timezone)::date
    OR EXISTS(SELECT 1 FROM expense_submission s WHERE s.organization_id=organization_uuid AND s.expense_id=e.id AND s.snapshot->>'timezone' IS DISTINCT FROM f.property_timezone)
    OR (e.transaction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.id=e.transaction_id AND t.occurred_at=c.captured_at))
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction' AND a.resource_id=i.id
      AND a.action='finance.external_payment.fee_prepared' AND a.actor_id=f.created_by
      AND a.after=jsonb_build_object('intentId',i.id,'captureId',c.id,'expenseId',e.id,'fee',c.settlement->'fee','propertyTimezone',f.property_timezone))
    THEN RAISE EXCEPTION 'actual original captured fee expense source required'; END IF;
END $$;

CREATE FUNCTION app_guard_external_payment_fee() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM expense e JOIN property p ON p.organization_id=e.organization_id AND p.id=e.property_id
      WHERE e.organization_id=NEW.organization_id AND e.id=NEW.expense_id AND p.timezone=NEW.property_timezone
      AND e.xmin::text=pg_current_xact_id()::xid::text AND EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=e.organization_id
        AND a.resource_type='expense' AND a.resource_id=e.id AND a.action='expense.created' AND a.actor_id=NEW.created_by
        AND a.xmin::text=pg_current_xact_id()::xid::text))
    THEN RAISE EXCEPTION 'new original fee expense and attributed audit required'; END IF;
  PERFORM app_assert_external_payment_fee(NEW.id,NEW.organization_id); RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_fee_guard AFTER INSERT ON external_payment_fee
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_payment_fee();

CREATE FUNCTION app_guard_external_payment_fee_expense() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE fee_uuid uuid;
BEGIN
  SELECT id INTO fee_uuid FROM external_payment_fee WHERE organization_id=NEW.organization_id AND expense_id=NEW.id;
  IF fee_uuid IS NOT NULL THEN PERFORM app_assert_external_payment_fee(fee_uuid,NEW.organization_id); END IF; RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER expense_external_payment_fee_guard AFTER INSERT OR UPDATE ON expense
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_payment_fee_expense();

CREATE FUNCTION app_external_payment_fee_is_posted(capture_uuid uuid,organization_uuid uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_fee%ROWTYPE; e expense%ROWTYPE; c external_payment_capture%ROWTYPE; t financial_transaction%ROWTYPE;
BEGIN
  SELECT * INTO f FROM external_payment_fee WHERE organization_id=organization_uuid AND capture_id=capture_uuid;
  IF f.id IS NULL THEN RETURN false; END IF;
  PERFORM app_assert_external_payment_fee(f.id,organization_uuid);
  SELECT * INTO e FROM expense WHERE organization_id=organization_uuid AND id=f.expense_id;
  SELECT * INTO c FROM external_payment_capture WHERE organization_id=organization_uuid AND id=capture_uuid;
  SELECT * INTO t FROM financial_transaction WHERE organization_id=organization_uuid AND id=e.transaction_id;
  IF e.state<>'POSTED' OR t.id IS NULL OR NOT t.sealed OR t.occurred_at IS DISTINCT FROM c.captured_at
    OR EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=organization_uuid AND r.reverses_transaction_id=t.id) THEN RETURN false; END IF;
  PERFORM app_assert_expense_posting(e.id,organization_uuid);
  RETURN true;
END $$;

-- Additive replacement: preserve the original method/date/audit requirements and require a fully approved native expense for a deduction.
CREATE OR REPLACE FUNCTION app_require_original_external_method() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source external_payment_intent%ROWTYPE; capture external_payment_capture%ROWTYPE;
BEGIN
  IF NOT NEW.sealed OR NEW.reference NOT LIKE 'GUEST_DEPOSIT:%' THEN RETURN NEW; END IF;
  SELECT * INTO source FROM external_payment_intent WHERE organization_id=NEW.organization_id AND idempotency_key::text=substr(NEW.reference,15);
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO capture FROM external_payment_capture WHERE organization_id=NEW.organization_id AND intent_id=source.id;
  IF capture.id IS NULL OR capture.captured_at IS NULL OR capture.settlement IS NULL
    OR (capture.settlement->'fee'->>'amount' IS DISTINCT FROM '0.00' AND NOT app_external_payment_fee_is_posted(capture.id,NEW.organization_id))
    OR NEW.occurred_at IS DISTINCT FROM capture.captured_at OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=NEW.id
    AND a.action='finance.guest_deposit.received' AND a.actor_id=source.requested_by
    AND a.after->'input'->>'paymentMethodFingerprint'=source.input->'receipt'->>'paymentMethodFingerprint')
    THEN RAISE EXCEPTION 'original captured provider method review required'; END IF;
  RETURN NEW;
END $$;

COMMIT;
