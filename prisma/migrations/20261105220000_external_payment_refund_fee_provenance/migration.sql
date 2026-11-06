BEGIN;

-- Provenance and a single reserved cost head. All monetary changes still use native expense approval/correction.
CREATE TABLE external_payment_refund_fee (
  id uuid NOT NULL DEFAULT app_uuid_v7(), organization_id uuid NOT NULL, refund_intent_id uuid NOT NULL,
  capture_id uuid NOT NULL, original_expense_id uuid NOT NULL, correction_expense_id uuid,
  original_expense_version integer NOT NULL, current_cost decimal(18,2) NOT NULL, returned_fee decimal(18,2) NOT NULL,
  remaining_cost decimal(18,2) NOT NULL, currency char(3) NOT NULL, property_timezone text NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT external_payment_refund_fee_pkey PRIMARY KEY(id),
  CONSTRAINT external_payment_refund_fee_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_refund_fee_org_intent_fk FOREIGN KEY(organization_id,refund_intent_id) REFERENCES external_payment_refund_intent(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_payment_refund_fee_organization_id_capture_id_fkey FOREIGN KEY(organization_id,capture_id) REFERENCES external_payment_capture(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_refund_fee_org_original_fk FOREIGN KEY(organization_id,original_expense_id) REFERENCES expense(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_refund_fee_org_correction_fk FOREIGN KEY(organization_id,correction_expense_id) REFERENCES expense(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_payment_refund_fee_organization_id_created_by_fkey FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_payment_refund_fee_currency_fkey FOREIGN KEY(currency) REFERENCES currency(code) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT external_refund_fee_exact_cost CHECK(original_expense_version>0 AND current_cost>0 AND returned_fee>0 AND remaining_cost>=0
    AND current_cost-returned_fee=remaining_cost AND current_cost<>'NaN'::numeric AND returned_fee<>'NaN'::numeric AND remaining_cost<>'NaN'::numeric
    AND ((remaining_cost=0 AND correction_expense_id IS NULL) OR (remaining_cost>0 AND correction_expense_id IS NOT NULL))
    AND original_expense_id IS DISTINCT FROM correction_expense_id)
);
CREATE UNIQUE INDEX external_payment_refund_fee_org_id_unique ON external_payment_refund_fee(organization_id,id);
CREATE UNIQUE INDEX external_payment_refund_fee_intent_unique ON external_payment_refund_fee(organization_id,refund_intent_id);
CREATE UNIQUE INDEX external_payment_refund_fee_original_unique ON external_payment_refund_fee(organization_id,original_expense_id);
CREATE UNIQUE INDEX external_payment_refund_fee_correction_unique ON external_payment_refund_fee(organization_id,correction_expense_id);
CREATE INDEX external_payment_refund_fee_capture_idx ON external_payment_refund_fee(organization_id,capture_id,id);
ALTER TABLE external_payment_refund_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_payment_refund_fee FORCE ROW LEVEL SECURITY;
CREATE POLICY external_payment_refund_fee_tenant_isolation ON external_payment_refund_fee
USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER external_payment_refund_fee_no_update BEFORE UPDATE ON external_payment_refund_fee FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER external_payment_refund_fee_no_delete BEFORE DELETE ON external_payment_refund_fee FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_assert_external_refund_fee(binding_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
    OR r.capture_id IS DISTINCT FROM f.capture_id OR r.requested_by IS DISTINCT FROM f.created_by OR r.currency IS DISTINCT FROM f.currency
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

CREATE FUNCTION app_guard_external_refund_fee() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM expense e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.original_expense_id
    AND e.state='POSTED' AND e.version=NEW.original_expense_version)
    OR (NEW.correction_expense_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM expense e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.correction_expense_id
      AND e.state='DRAFT' AND e.transaction_id IS NULL AND e.xmin::text=pg_current_xact_id()::xid::text))
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='financial_transaction' AND a.resource_id=NEW.refund_intent_id
      AND a.action='finance.external_payment.refund_fee_prepared' AND a.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'current posted cost, fresh native draft and same-transaction attributed fee plan required'; END IF;
  PERFORM app_assert_external_refund_fee(NEW.id,NEW.organization_id); RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_refund_fee_native_guard AFTER INSERT ON external_payment_refund_fee
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_fee();

CREATE FUNCTION app_guard_external_refund_fee_expense() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_refund_fee%ROWTYPE;
BEGIN
  FOR f IN SELECT * FROM external_payment_refund_fee WHERE organization_id=NEW.organization_id AND (original_expense_id=NEW.id OR correction_expense_id=NEW.id) LOOP
    PERFORM app_assert_external_refund_fee(f.id,NEW.organization_id);
  END LOOP;
  IF NEW.corrects_expense_id IS NOT NULL AND (EXISTS(SELECT 1 FROM external_payment_fee WHERE organization_id=NEW.organization_id AND expense_id=NEW.corrects_expense_id)
    OR EXISTS(SELECT 1 FROM external_payment_refund_fee WHERE organization_id=NEW.organization_id AND correction_expense_id=NEW.corrects_expense_id))
    AND NOT EXISTS(SELECT 1 FROM external_payment_refund_fee WHERE organization_id=NEW.organization_id AND original_expense_id=NEW.corrects_expense_id AND correction_expense_id=NEW.id)
  THEN RAISE EXCEPTION 'provider cost correction requires its exact independently verified fee plan'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER expense_external_refund_fee_guard AFTER INSERT OR UPDATE ON expense
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_fee_expense();

-- Preparation does not grant financial admission; prove the native cost offset and its admitted guest source.
CREATE FUNCTION app_external_refund_fee_is_posted(refund_uuid uuid,organization_uuid uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f external_payment_refund_fee%ROWTYPE; r external_payment_refund_intent%ROWTYPE; e expense%ROWTYPE; replacement expense%ROWTYPE;
  reversal financial_transaction%ROWTYPE; admitted financial_transaction%ROWTYPE; actual_at timestamptz;
BEGIN
  SELECT * INTO f FROM external_payment_refund_fee WHERE organization_id=organization_uuid AND refund_intent_id=refund_uuid;
  IF f.id IS NULL THEN RETURN false; END IF;
  PERFORM app_assert_external_refund_fee(f.id,organization_uuid);
  SELECT * INTO r FROM external_payment_refund_intent WHERE organization_id=organization_uuid AND id=refund_uuid;
  SELECT * INTO e FROM expense WHERE organization_id=organization_uuid AND id=f.original_expense_id;
  SELECT * INTO replacement FROM expense WHERE organization_id=organization_uuid AND id=f.correction_expense_id;
  SELECT t.* INTO reversal FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.reverses_transaction_id=e.transaction_id;
  SELECT t.* INTO admitted FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.idempotency_key='guest-deposit:'||r.idempotency_key;
  SELECT observation.refunded_at INTO actual_at FROM external_payment_refund_identity identity
    JOIN external_payment_refund_evidence observation ON observation.organization_id=identity.organization_id AND observation.identity_id=identity.id
    WHERE identity.organization_id=organization_uuid AND identity.intent_id=r.id AND observation.state='COMPLETED'
    ORDER BY observation.provider_updated_at,observation.id LIMIT 1;
  IF e.state IS DISTINCT FROM 'VOIDED' OR e.version IS DISTINCT FROM f.original_expense_version+1 OR reversal.id IS NULL OR NOT reversal.sealed
    OR reversal.created_by IS DISTINCT FROM r.requested_by OR reversal.occurred_at IS DISTINCT FROM actual_at
    OR admitted.id IS NULL OR NOT admitted.sealed OR admitted.created_by IS DISTINCT FROM r.requested_by OR admitted.occurred_at IS DISTINCT FROM actual_at
    OR (f.remaining_cost>0 AND (replacement.id IS NULL OR replacement.transaction_id IS NULL OR replacement.state NOT IN ('POSTED','VOIDED')
      OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=organization_uuid AND t.id=replacement.transaction_id
        AND t.sealed AND t.created_by=r.requested_by AND t.occurred_at=actual_at)))
    THEN RETURN false; END IF;
  IF replacement.id IS NOT NULL THEN PERFORM app_assert_expense_posting(replacement.id,organization_uuid); END IF;
  RETURN true;
END $$;

COMMIT;
