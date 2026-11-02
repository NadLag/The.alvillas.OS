BEGIN;
CREATE TABLE company_expense_invoice_link (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(),organization_id uuid NOT NULL,invoice_line_id uuid NOT NULL,company_expense_id uuid NOT NULL,plan_version integer NOT NULL,data_class text NOT NULL,version integer NOT NULL,state text NOT NULL,reason text NOT NULL,created_by uuid NOT NULL,created_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT company_expense_invoice_link_organization_id_id_key UNIQUE(organization_id,id),
 CONSTRAINT company_expense_invoice_source_version_key UNIQUE(organization_id,invoice_line_id,version),
 CONSTRAINT company_expense_invoice_link_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_invoice_line_fk FOREIGN KEY(organization_id,invoice_line_id) REFERENCES supplier_invoice_line(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_invoice_plan_fk FOREIGN KEY(organization_id,company_expense_id) REFERENCES company_expense_plan(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_invoice_revision_fk FOREIGN KEY(organization_id,company_expense_id,plan_version) REFERENCES company_expense_revision(organization_id,company_expense_id,version) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_invoice_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_invoice_link_values CHECK(version>=1 AND state IN('ATTACHED','RELEASED') AND data_class IN('FINANCIAL','STAFF_COMPENSATION') AND length(btrim(reason)) BETWEEN 6 AND 500)
);
CREATE INDEX company_expense_invoice_plan_history_idx ON company_expense_invoice_link(organization_id,company_expense_id,id);
ALTER TABLE company_expense_invoice_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_expense_invoice_link FORCE ROW LEVEL SECURITY;
CREATE POLICY company_expense_invoice_link_tenant_isolation ON company_expense_invoice_link USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER company_expense_invoice_link_immutable BEFORE UPDATE OR DELETE ON company_expense_invoice_link FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE FUNCTION app_company_expense_invoice_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE previous company_expense_invoice_link;source supplier_invoice_line;plan company_expense_revision;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':company-invoice-source:'||NEW.invoice_line_id::text,0));
 SELECT * INTO previous FROM company_expense_invoice_link WHERE organization_id=NEW.organization_id AND invoice_line_id=NEW.invoice_line_id ORDER BY version DESC LIMIT 1;
 SELECT * INTO source FROM supplier_invoice_line WHERE organization_id=NEW.organization_id AND id=NEW.invoice_line_id;
 PERFORM id FROM company_expense_plan WHERE organization_id=NEW.organization_id AND id=NEW.company_expense_id FOR SHARE;
 SELECT * INTO plan FROM company_expense_revision WHERE organization_id=NEW.organization_id AND company_expense_id=NEW.company_expense_id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>COALESCE(previous.version,0)+1 OR source.id IS NULL OR source.property_id IS NOT NULL OR source.reservation_id IS NOT NULL OR plan.id IS NULL OR NEW.plan_version<>plan.version OR NEW.created_at>clock_timestamp() OR NEW.created_at<source.created_at OR NEW.created_at<previous.created_at OR NEW.created_at<plan.created_at
  OR NOT EXISTS(SELECT 1 FROM supplier_invoice_recognition_line WHERE organization_id=NEW.organization_id AND invoice_line_id=NEW.invoice_line_id)
  OR NEW.data_class IS DISTINCT FROM (CASE WHEN previous.data_class='STAFF_COMPENSATION' THEN previous.data_class ELSE plan.data_class END)
  OR NEW.state='ATTACHED' AND (previous.state='ATTACHED' OR plan.state<>'PLANNED' OR source.currency<>plan.currency OR source.category<>plan.category OR source.cost_center IS DISTINCT FROM plan.cost_center)
  OR NEW.state='RELEASED' AND (previous.id IS NULL OR previous.state<>'ATTACHED' OR previous.company_expense_id<>NEW.company_expense_id)
 THEN RAISE EXCEPTION 'company invoice association requires its consecutive original company-only source and plan';END IF;RETURN NEW;
END $$;
CREATE TRIGGER company_expense_invoice_source_guard BEFORE INSERT ON company_expense_invoice_link FOR EACH ROW EXECUTE FUNCTION app_company_expense_invoice_source_guard();
CREATE FUNCTION app_company_expense_invoice_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=NEW.organization_id AND resource_type='company_expense' AND resource_id=NEW.company_expense_id AND actor_id=NEW.created_by AND action=(CASE WHEN NEW.state='ATTACHED' THEN 'company_expense.invoice_attached' ELSE 'company_expense.invoice_released' END) AND after->>'linkId'=NEW.id::text AND after->>'invoiceLineId'=NEW.invoice_line_id::text AND after->>'version'=NEW.version::text AND occurred_at=NEW.created_at AND reason=NEW.reason)
 THEN RAISE EXCEPTION 'company invoice association and native audit must commit atomically';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER company_expense_invoice_atomic_audit AFTER INSERT ON company_expense_invoice_link DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_company_expense_invoice_audit_guard();
COMMIT;
