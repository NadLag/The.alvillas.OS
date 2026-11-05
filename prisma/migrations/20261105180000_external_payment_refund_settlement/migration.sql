BEGIN;

CREATE TABLE external_payment_refund_settlement (
  id uuid NOT NULL DEFAULT app_uuid_v7(), organization_id uuid NOT NULL, evidence_id uuid NOT NULL,
  settlement jsonb NOT NULL, observed_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT external_payment_refund_settlement_pkey PRIMARY KEY(id)
);
CREATE UNIQUE INDEX external_payment_refund_settlement_org_id_unique ON external_payment_refund_settlement(organization_id,id);
CREATE UNIQUE INDEX external_payment_refund_settlement_evidence_unique ON external_payment_refund_settlement(organization_id,evidence_id);
ALTER TABLE external_payment_refund_settlement ADD CONSTRAINT external_payment_refund_settlement_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE external_payment_refund_settlement ADD CONSTRAINT external_refund_settlement_org_evidence_fk FOREIGN KEY(organization_id,evidence_id) REFERENCES external_payment_refund_evidence(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE external_payment_refund_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_payment_refund_settlement FORCE ROW LEVEL SECURITY;
CREATE POLICY external_payment_refund_settlement_tenant_isolation ON external_payment_refund_settlement
USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER external_payment_refund_settlement_no_update BEFORE UPDATE ON external_payment_refund_settlement FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER external_payment_refund_settlement_no_delete BEFORE DELETE ON external_payment_refund_settlement FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_guard_external_refund_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE observation external_payment_refund_evidence%ROWTYPE; source external_payment_refund_intent%ROWTYPE; gross numeric; fee numeric; net numeric; expected jsonb;
BEGIN
  SELECT * INTO observation FROM external_payment_refund_evidence WHERE organization_id=NEW.organization_id AND id=NEW.evidence_id;
  SELECT r.* INTO source FROM external_payment_refund_intent r JOIN external_payment_refund_identity i ON i.organization_id=r.organization_id AND i.intent_id=r.id
    WHERE i.organization_id=NEW.organization_id AND i.id=observation.identity_id;
  gross:=(NEW.settlement->'gross'->>'amount')::numeric; fee:=(NEW.settlement->'fee'->>'amount')::numeric; net:=(NEW.settlement->'net'->>'amount')::numeric;
  expected:=jsonb_build_object('schemaVersion',1,'basis','ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN',
    'gross',jsonb_build_object('amount',source.amount::text,'currency',source.currency),
    'fee',jsonb_build_object('amount',fee::numeric(18,2)::text,'currency',source.currency),
    'net',jsonb_build_object('amount',net::numeric(18,2)::text,'currency',source.currency),
    'totalRefunded',CASE WHEN NEW.settlement->'totalRefunded'='null'::jsonb THEN 'null'::jsonb ELSE
      jsonb_build_object('amount',((NEW.settlement->'totalRefunded'->>'amount')::numeric(18,2))::text,'currency',source.currency) END);
  IF observation.id IS NULL OR source.id IS NULL OR NEW.settlement IS DISTINCT FROM expected OR gross IS DISTINCT FROM source.amount
    OR fee IS NULL OR net IS NULL OR fee<0 OR net<0 OR gross-fee<>net OR fee='NaN'::numeric OR net='NaN'::numeric
    OR (NEW.settlement->'totalRefunded'<>'null'::jsonb AND (NEW.settlement->'totalRefunded'->>'amount')::numeric<gross)
    OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id IS NULL
      AND a.action='finance.external_payment.refund_settlement_retained' AND a.resource_type='financial_transaction' AND a.resource_id=source.id
      AND a.after=jsonb_build_object('intentId',source.id,'evidenceId',observation.id,'settlementId',NEW.id,'settlement',NEW.settlement)
      AND a.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'exact original provider refund settlement and attributed audit required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER external_payment_refund_settlement_native_guard AFTER INSERT ON external_payment_refund_settlement
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_settlement();

CREATE FUNCTION app_guard_external_refund_net_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
    OR (latest.settlement->'fee'->>'amount')::numeric IS DISTINCT FROM 0::numeric
    OR (latest.settlement->'net'->>'amount')::numeric IS DISTINCT FROM source.amount
  THEN RAISE EXCEPTION 'committed exact refund net and supported native fee treatment required'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_transaction_external_refund_net_guard AFTER INSERT OR UPDATE ON financial_transaction
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_external_refund_net_admission();

COMMIT;
