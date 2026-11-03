BEGIN;
CREATE TABLE company_expense_command_receipt (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(), organization_id uuid NOT NULL, idempotency_key uuid NOT NULL,
 request_hash char(64) NOT NULL, operation text NOT NULL, company_expense_id uuid NOT NULL, result_id uuid NOT NULL,
 result_version integer NOT NULL, data_class text NOT NULL, created_by uuid NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT company_command_org_id_key UNIQUE(organization_id,id),
 CONSTRAINT company_command_nonce_key UNIQUE(organization_id,idempotency_key),
 CONSTRAINT company_command_org_fk FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_command_plan_fk FOREIGN KEY(organization_id,company_expense_id) REFERENCES company_expense_plan(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_command_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_command_values CHECK(result_version>=1 AND request_hash~'^[a-f0-9]{64}$' AND operation IN('CREATE','REVISE','CANCEL','INVOICE_SOURCE','EMPLOYEE_SOURCE') AND data_class IN('FINANCIAL','STAFF_COMPENSATION'))
);
CREATE INDEX company_command_actor_history_idx ON company_expense_command_receipt(organization_id,created_by,id);
ALTER TABLE company_expense_command_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_expense_command_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY company_expense_command_receipt_tenant_isolation ON company_expense_command_receipt
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER company_command_receipt_immutable BEFORE UPDATE OR DELETE ON company_expense_command_receipt
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_company_command_result_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor_uuid uuid; source_class text; source_version integer; source_at timestamptz; source_state text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':company-expense-command:'||NEW.idempotency_key::text,0));
 IF NEW.operation IN('CREATE','REVISE','CANCEL') THEN
  SELECT created_by,data_class,version,created_at,state INTO actor_uuid,source_class,source_version,source_at,source_state
   FROM company_expense_revision WHERE organization_id=NEW.organization_id AND company_expense_id=NEW.company_expense_id AND id=NEW.result_id;
  IF (NEW.operation='CREATE' AND (source_version<>1 OR source_state<>'PLANNED' OR NOT EXISTS(SELECT 1 FROM company_expense_plan WHERE organization_id=NEW.organization_id AND id=NEW.company_expense_id AND idempotency_key=NEW.idempotency_key)))
   OR (NEW.operation='REVISE' AND (source_version<2 OR source_state<>'PLANNED')) OR (NEW.operation='CANCEL' AND source_state<>'CANCELLED')
  THEN RAISE EXCEPTION 'company command receipt requires its actual native operation result';END IF;
 ELSIF NEW.operation='INVOICE_SOURCE' THEN
  SELECT created_by,data_class,version,created_at INTO actor_uuid,source_class,source_version,source_at
   FROM company_expense_invoice_link WHERE organization_id=NEW.organization_id AND company_expense_id=NEW.company_expense_id AND id=NEW.result_id;
 ELSIF NEW.operation='EMPLOYEE_SOURCE' THEN
  SELECT created_by,data_class,version,created_at INTO actor_uuid,source_class,source_version,source_at
   FROM company_expense_compensation_link WHERE organization_id=NEW.organization_id AND company_expense_id=NEW.company_expense_id AND id=NEW.result_id;
 END IF;
 IF actor_uuid IS NULL OR actor_uuid IS DISTINCT FROM NEW.created_by OR source_class IS DISTINCT FROM NEW.data_class
  OR source_version IS DISTINCT FROM NEW.result_version OR NEW.created_at<source_at OR NEW.created_at>clock_timestamp()
 THEN RAISE EXCEPTION 'company command receipt requires its actual tenant-owned native result and author';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER company_command_result_guard BEFORE INSERT ON company_expense_command_receipt
 FOR EACH ROW EXECUTE FUNCTION app_company_command_result_guard();

CREATE FUNCTION app_company_command_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
   AND a.resource_type='company_expense' AND a.resource_id=NEW.company_expense_id AND a.action='company_expense.command_acknowledged'
   AND a.after->>'receiptId'=NEW.id::text AND a.after->>'idempotencyKey'=NEW.idempotency_key::text AND a.after->>'requestHash'=NEW.request_hash
   AND a.after->>'operation'=NEW.operation AND a.after->>'resultId'=NEW.result_id::text AND a.after->>'version'=NEW.result_version::text
   AND a.after->>'dataClass'=NEW.data_class AND a.occurred_at=NEW.created_at)
 THEN RAISE EXCEPTION 'company command acknowledgement requires its atomic native-result audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER company_command_atomic_audit AFTER INSERT ON company_expense_command_receipt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_company_command_audit_guard();
COMMIT;
