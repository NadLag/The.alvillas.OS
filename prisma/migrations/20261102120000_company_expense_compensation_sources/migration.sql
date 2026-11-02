BEGIN;
CREATE TABLE company_expense_compensation_link (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(), organization_id uuid NOT NULL, employee_cost_id uuid NOT NULL,
 company_expense_id uuid NOT NULL, plan_version integer NOT NULL, data_class text NOT NULL,
 version integer NOT NULL, state text NOT NULL, reason text NOT NULL, created_by uuid NOT NULL,
 created_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT company_compensation_org_id_key UNIQUE(organization_id,id),
 CONSTRAINT company_compensation_source_version_key UNIQUE(organization_id,employee_cost_id,version),
 CONSTRAINT company_compensation_org_fk FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_compensation_cost_fk FOREIGN KEY(organization_id,employee_cost_id) REFERENCES employee_compensation_cost(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_compensation_plan_fk FOREIGN KEY(organization_id,company_expense_id) REFERENCES company_expense_plan(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_compensation_revision_fk FOREIGN KEY(organization_id,company_expense_id,plan_version) REFERENCES company_expense_revision(organization_id,company_expense_id,version) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_compensation_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_compensation_link_values CHECK(version>=1 AND state IN('ATTACHED','RELEASED') AND data_class='STAFF_COMPENSATION' AND length(btrim(reason)) BETWEEN 6 AND 500)
);
CREATE INDEX company_compensation_plan_history_idx ON company_expense_compensation_link(organization_id,company_expense_id,id);
ALTER TABLE company_expense_compensation_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_expense_compensation_link FORCE ROW LEVEL SECURITY;
CREATE POLICY company_expense_compensation_link_tenant_isolation ON company_expense_compensation_link
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER company_compensation_link_immutable BEFORE UPDATE OR DELETE ON company_expense_compensation_link
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_company_compensation_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE previous company_expense_compensation_link; source employee_compensation_cost; plan company_expense_revision; run_uuid uuid; journal_uuid uuid;
BEGIN
 PERFORM id FROM company_expense_plan WHERE organization_id=NEW.organization_id AND id=NEW.company_expense_id FOR SHARE;
 SELECT * INTO source FROM employee_compensation_cost WHERE organization_id=NEW.organization_id AND id=NEW.employee_cost_id;
 SELECT run_id INTO run_uuid FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=source.submission_id;
 IF source.id IS NULL OR run_uuid IS NULL OR source.property_id IS NOT NULL OR source.reservation_id IS NOT NULL
 THEN RAISE EXCEPTION 'company compensation association requires its actual company-only earned source';END IF;
 -- Match the native recognition/settlement lock order before observing original journal reversals.
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-compensation-run:'||run_uuid::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':employee-submission:'||source.submission_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':company-compensation-source:'||NEW.employee_cost_id::text,0));
 SELECT * INTO previous FROM company_expense_compensation_link WHERE organization_id=NEW.organization_id AND employee_cost_id=NEW.employee_cost_id ORDER BY version DESC LIMIT 1;
 SELECT * INTO plan FROM company_expense_revision WHERE organization_id=NEW.organization_id AND company_expense_id=NEW.company_expense_id ORDER BY version DESC LIMIT 1;
 SELECT transaction_id INTO journal_uuid FROM employee_compensation_recognition_line WHERE organization_id=NEW.organization_id AND cost_id=source.id;
 IF NEW.version<>coalesce(previous.version,0)+1 OR plan.id IS NULL OR NEW.plan_version<>plan.version OR journal_uuid IS NULL
  OR NEW.created_at>clock_timestamp() OR NEW.created_at<source.created_at OR NEW.created_at<previous.created_at OR NEW.created_at<plan.created_at
  OR NEW.data_class IS DISTINCT FROM 'STAFF_COMPENSATION'
  OR (NEW.state='ATTACHED' AND (previous.state='ATTACHED' OR plan.state<>'PLANNED' OR plan.data_class<>'STAFF_COMPENSATION'
    OR source.currency<>plan.currency OR source.category<>plan.category OR source.cost_center IS DISTINCT FROM plan.cost_center
    OR EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=NEW.organization_id AND reverses_transaction_id=journal_uuid)))
  OR (NEW.state='RELEASED' AND (previous.id IS NULL OR previous.state<>'ATTACHED' OR previous.company_expense_id<>NEW.company_expense_id))
 THEN RAISE EXCEPTION 'company compensation association requires its consecutive recognized salary source and plan';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER company_compensation_source_guard BEFORE INSERT ON company_expense_compensation_link
 FOR EACH ROW EXECUTE FUNCTION app_company_compensation_source_guard();

CREATE FUNCTION app_company_compensation_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log a JOIN employee_compensation_cost c ON c.organization_id=a.organization_id AND c.id=NEW.employee_cost_id
   JOIN employee_compensation_recognition_line r ON r.organization_id=c.organization_id AND r.cost_id=c.id
   WHERE a.organization_id=NEW.organization_id AND a.resource_type='company_expense' AND a.resource_id=NEW.company_expense_id AND a.actor_id=NEW.created_by
    AND a.action=(CASE WHEN NEW.state='ATTACHED' THEN 'company_expense.compensation_attached' ELSE 'company_expense.compensation_released' END)
    AND a.after->>'linkId'=NEW.id::text AND a.after->>'employeeCostId'=NEW.employee_cost_id::text AND a.after->>'version'=NEW.version::text
    AND a.after->>'claimId'=c.claim_id::text AND a.after->>'submissionId'=c.submission_id::text AND a.after->>'transactionId'=r.transaction_id::text
    AND a.after->>'state'=NEW.state AND a.after->>'planVersion'=NEW.plan_version::text AND a.after->>'dataClass'='STAFF_COMPENSATION'
    AND (a.after->>'amount')::numeric=c.amount AND a.after->>'currency'=trim(c.currency) AND a.occurred_at=NEW.created_at AND a.reason=NEW.reason)
 THEN RAISE EXCEPTION 'company compensation association requires its atomic attributed salary audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER company_compensation_atomic_audit AFTER INSERT ON company_expense_compensation_link
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_company_compensation_audit_guard();
COMMIT;
