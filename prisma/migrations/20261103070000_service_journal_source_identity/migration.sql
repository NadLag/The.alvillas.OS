BEGIN;
-- OWNER_SERVICES is an existing reporting bucket, not the identity of an allocation producer.
-- Service-specific accounts, explicit source markers and released collection ownership require acknowledgement.
CREATE OR REPLACE FUNCTION app_service_posting_journal_ack_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE account_code text;owned boolean;
BEGIN
 SELECT code INTO account_code FROM ledger_account WHERE organization_id=NEW.organization_id AND id=NEW.ledger_account_id;
 owned=COALESCE(NEW.dimensions->>'source'='SERVICE_ALLOCATION',false)
  OR COALESCE(NEW.dimensions ? 'service_source_id',false) OR COALESCE(NEW.dimensions ? 'service_admission_id',false)
  OR COALESCE(NEW.bucket IN('SERVICE_ALLOCATION','ALVILLAS_SERVICE_REVENUE','SERVICE_TAX'),false)
  OR COALESCE(account_code IN('ALVILLAS_SERVICE_REVENUE','SERVICE_TAX_PAYABLE'),false);
 IF NOT owned AND account_code IN('OWNER_PAYABLE','UNALLOCATED_COLLECTIONS') THEN
  owned=EXISTS(SELECT 1 FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
   WHERE p.organization_id=NEW.organization_id AND p.transaction_id=NEW.transaction_id AND p.side<>NEW.side
    AND((account_code='OWNER_PAYABLE' AND a.code='UNALLOCATED_COLLECTIONS') OR(account_code='UNALLOCATED_COLLECTIONS' AND a.code='OWNER_PAYABLE')));
 END IF;
 IF owned AND NOT EXISTS(SELECT 1 FROM service_allocation_posting a WHERE a.organization_id=NEW.organization_id AND a.transaction_id=NEW.transaction_id
  AND a.source_id::text=NEW.dimensions->>'service_source_id' AND a.admission_id::text=NEW.dimensions->>'service_admission_id')
 THEN RAISE EXCEPTION 'a service movement requires its native reviewed source acknowledgement in the same transaction'; END IF;
 RETURN NULL;
END $$;
DROP TRIGGER service_posting_native_ack ON posting;
CREATE CONSTRAINT TRIGGER service_posting_native_ack AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_service_posting_journal_ack_guard();
COMMIT;
