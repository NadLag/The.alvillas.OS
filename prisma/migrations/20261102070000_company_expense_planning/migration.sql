BEGIN;
CREATE TABLE company_expense_plan (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(), organization_id uuid NOT NULL, idempotency_key uuid NOT NULL, created_by uuid NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT company_expense_plan_organization_id_id_key UNIQUE(organization_id,id),
 CONSTRAINT company_expense_plan_organization_id_idempotency_key_key UNIQUE(organization_id,idempotency_key),
 CONSTRAINT company_expense_plan_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_plan_organization_id_created_by_fkey FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE TABLE company_expense_revision (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(), organization_id uuid NOT NULL, company_expense_id uuid NOT NULL, version integer NOT NULL, state text NOT NULL,
 amount numeric(18,2) NOT NULL, currency char(3) NOT NULL, category text NOT NULL, cost_center text NOT NULL, purpose text NOT NULL, due_on date NOT NULL, timezone text NOT NULL,
 data_class text NOT NULL, config_rule_id uuid NOT NULL, policy_snapshot jsonb NOT NULL, reason text NOT NULL, created_by uuid NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT company_expense_revision_organization_id_id_key UNIQUE(organization_id,id),
 CONSTRAINT company_expense_revision_org_source_version_key UNIQUE(organization_id,company_expense_id,version),
 CONSTRAINT company_expense_revision_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_revision_organization_id_company_expense_id_fkey FOREIGN KEY(organization_id,company_expense_id) REFERENCES company_expense_plan(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_revision_policy_fk FOREIGN KEY(organization_id,config_rule_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_revision_organization_id_created_by_fkey FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT company_expense_revision_values CHECK(version>=1 AND amount>0 AND state IN('PLANNED','CANCELLED') AND data_class IN('FINANCIAL','STAFF_COMPENSATION') AND isfinite(due_on) AND due_on BETWEEN date '0001-01-01' AND date '9999-12-31' AND category~'^[a-z][a-z0-9_.-]{0,119}$' AND cost_center~'^[a-z][a-z0-9_.-]{0,119}$' AND length(btrim(purpose)) BETWEEN 3 AND 1000 AND length(btrim(reason)) BETWEEN 6 AND 500)
);
CREATE INDEX company_expense_revision_org_due_source_idx ON company_expense_revision(organization_id,due_on,company_expense_id);
CREATE TABLE recurring_company_expense_occurrence (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(),organization_id uuid NOT NULL,schedule_id uuid NOT NULL,"on" date NOT NULL,config_rule_id uuid NOT NULL,
 company_expense_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT recurring_company_expense_occurrence_organization_id_id_key UNIQUE(organization_id,id),
 CONSTRAINT recurring_company_expense_schedule_on_key UNIQUE(organization_id,schedule_id,"on"),
 CONSTRAINT recurring_company_expense_plan_key UNIQUE(organization_id,company_expense_id),
 CONSTRAINT recurring_company_expense_occurrence_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT recurring_company_expense_plan_fk FOREIGN KEY(organization_id,company_expense_id) REFERENCES company_expense_plan(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT recurring_company_expense_policy_fk FOREIGN KEY(organization_id,config_rule_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT recurring_company_expense_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT recurring_company_expense_finite_date CHECK(isfinite("on"))
);
ALTER TABLE company_expense_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_expense_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY company_expense_plan_tenant_isolation ON company_expense_plan USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE company_expense_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_expense_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY company_expense_revision_tenant_isolation ON company_expense_revision USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE recurring_company_expense_occurrence ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_company_expense_occurrence FORCE ROW LEVEL SECURITY;
CREATE POLICY recurring_company_expense_occurrence_tenant_isolation ON recurring_company_expense_occurrence USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER company_expense_plan_immutable BEFORE UPDATE OR DELETE ON company_expense_plan FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER company_expense_revision_immutable BEFORE UPDATE OR DELETE ON company_expense_revision FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER recurring_company_expense_occurrence_immutable BEFORE UPDATE OR DELETE ON recurring_company_expense_occurrence FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_company_expense_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE previous company_expense_revision;rule config_rule;category_value jsonb;center_value jsonb;plan company_expense_plan;
BEGIN
 SELECT * INTO plan FROM company_expense_plan WHERE organization_id=NEW.organization_id AND id=NEW.company_expense_id FOR UPDATE;
 SELECT * INTO previous FROM company_expense_revision WHERE organization_id=NEW.organization_id AND company_expense_id=NEW.company_expense_id ORDER BY version DESC LIMIT 1;
 IF plan.id IS NULL OR NEW.version<>COALESCE(previous.version,0)+1 OR previous.state='CANCELLED' OR NEW.created_at<plan.created_at OR NEW.created_at>clock_timestamp()
  OR previous.id IS NULL AND (NEW.state<>'PLANNED' OR NEW.created_by<>plan.created_by)
  OR previous.data_class='STAFF_COMPENSATION' AND NEW.data_class<>'STAFF_COMPENSATION'
 THEN RAISE EXCEPTION 'company expense revisions require consecutive immutable source history';END IF;
 IF NEW.state='CANCELLED' THEN
  IF previous.id IS NULL OR (to_jsonb(NEW)-ARRAY['id','version','state','reason','created_by','created_at']) IS DISTINCT FROM (to_jsonb(previous)-ARRAY['id','version','state','reason','created_by','created_at']) THEN RAISE EXCEPTION 'cancellation must preserve original company cost facts';END IF;
 ELSE
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.config_rule_id;
  SELECT item INTO category_value FROM jsonb_array_elements(rule.value->'categories') item WHERE item->>'key'=NEW.category;
  SELECT item INTO center_value FROM jsonb_array_elements(rule.value->'cost_centers') item WHERE item->>'key'=NEW.cost_center;
  IF rule.id IS NULL OR rule.key<>'finance.company_expenses' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL OR rule.lifecycle<>'ACTIVE'
   OR rule.effective_from>NEW.created_at OR rule.effective_to IS NOT NULL AND rule.effective_to<=NEW.created_at
   OR EXISTS(SELECT 1 FROM config_rule newer WHERE newer.organization_id=NEW.organization_id AND newer.key=rule.key AND newer.scope_type='organization' AND newer.scope_id IS NULL AND newer.lifecycle='ACTIVE' AND newer.effective_from<=NEW.created_at AND (newer.effective_to IS NULL OR newer.effective_to>NEW.created_at) AND newer.version>rule.version)
   OR category_value IS NULL OR center_value IS NULL OR category_value->>'data_class' NOT IN('FINANCIAL','STAFF_COMPENSATION')
   OR NEW.data_class IS DISTINCT FROM (CASE WHEN previous.data_class='STAFF_COMPENSATION' THEN previous.data_class ELSE category_value->>'data_class' END)
   OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('category',category_value,'costCenter',center_value)
   OR NOT EXISTS(SELECT 1 FROM currency WHERE code=NEW.currency) OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone)
  THEN RAISE EXCEPTION 'company expense requires actual current configured category, cost center, currency and timezone';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER company_expense_revision_source_guard BEFORE INSERT ON company_expense_revision FOR EACH ROW EXECUTE FUNCTION app_company_expense_revision_guard();
CREATE FUNCTION app_company_expense_revision_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=NEW.organization_id AND resource_type='company_expense' AND resource_id=NEW.company_expense_id AND actor_id=NEW.created_by AND action=CASE WHEN NEW.version=1 THEN 'company_expense.created' WHEN NEW.state='CANCELLED' THEN 'company_expense.cancelled' ELSE 'company_expense.revised' END AND after->>'revisionId'=NEW.id::text AND after->>'version'=NEW.version::text AND occurred_at=NEW.created_at AND reason=NEW.reason)
 THEN RAISE EXCEPTION 'company expense revision and original audit must commit atomically';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER company_expense_revision_atomic_audit AFTER INSERT ON company_expense_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_company_expense_revision_audit_guard();
CREATE FUNCTION app_company_expense_plan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM company_expense_revision WHERE organization_id=NEW.organization_id AND company_expense_id=NEW.id AND version=1 AND created_by=NEW.created_by AND created_at=NEW.created_at) THEN RAISE EXCEPTION 'company expense identity requires its original attributed revision';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER company_expense_plan_original_revision AFTER INSERT ON company_expense_plan DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_company_expense_plan_guard();
CREATE FUNCTION app_recurring_company_expense_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule;original company_expense_revision;plan company_expense_plan;schedule jsonb;anchor date;cadence jsonb;months integer;month_end integer;local_now timestamp;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.config_rule_id;
 SELECT * INTO plan FROM company_expense_plan WHERE organization_id=NEW.organization_id AND id=NEW.company_expense_id;
 SELECT * INTO original FROM company_expense_revision WHERE organization_id=NEW.organization_id AND company_expense_id=NEW.company_expense_id AND version=1;
 SELECT item INTO schedule FROM jsonb_array_elements(rule.value->'expenses') item WHERE lower(item->>'id')=NEW.schedule_id::text;
 anchor=(schedule->>'start_on')::date;cadence=schedule->'cadence';months=(extract(year FROM NEW."on")-extract(year FROM anchor))::integer*12+(extract(month FROM NEW."on")-extract(month FROM anchor))::integer;
 month_end=extract(day FROM date_trunc('month',NEW."on")+interval '1 month - 1 day')::integer;local_now=clock_timestamp() AT TIME ZONE original.timezone;
 IF rule.id IS NULL OR rule.key<>'finance.recurring_company_expenses' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
  OR rule.value->>'source' IS DISTINCT FROM 'COMPANY_EXPENSE_PLAN' OR rule.value->>'principal' IS DISTINCT FROM 'CURRENT_CONFIGURATION_AUTHOR' OR rule.lifecycle<>'ACTIVE'
  OR rule.created_by IS DISTINCT FROM NEW.created_by OR rule.effective_from>NEW.created_at OR rule.effective_to IS NOT NULL AND rule.effective_to<=NEW.created_at OR NEW.created_at>clock_timestamp()
  OR EXISTS(SELECT 1 FROM config_rule newer WHERE newer.organization_id=NEW.organization_id AND newer.key=rule.key AND newer.scope_type='organization' AND newer.scope_id IS NULL AND newer.lifecycle='ACTIVE' AND newer.effective_from<=clock_timestamp() AND (newer.effective_to IS NULL OR newer.effective_to>clock_timestamp()) AND newer.version>rule.version)
  OR original.id IS NULL OR original.state<>'PLANNED' OR original.created_by IS DISTINCT FROM NEW.created_by OR plan.created_by IS DISTINCT FROM NEW.created_by
  OR original.due_on IS DISTINCT FROM NEW."on" OR original.amount IS DISTINCT FROM (schedule->'draft'->>'amount')::numeric OR original.currency::text IS DISTINCT FROM schedule->'draft'->>'currency'
  OR original.category IS DISTINCT FROM schedule->'draft'->>'category' OR original.cost_center IS DISTINCT FROM schedule->'draft'->>'costCenter' OR original.purpose IS DISTINCT FROM schedule->'draft'->>'purpose'
  OR schedule IS NULL OR NEW."on"<anchor OR schedule->>'end_on' IS NOT NULL AND NEW."on">(schedule->>'end_on')::date
  OR NEW."on">local_now::date OR NEW."on"=local_now::date AND to_char(local_now,'HH24:MI')<schedule->>'run_at'
  OR cadence->>'kind' NOT IN('DAY','WEEK','MONTH') OR (cadence->>'every')::integer<1
  OR cadence->>'kind'='DAY' AND (NEW."on"-anchor)%(cadence->>'every')::integer<>0
  OR cadence->>'kind'='WEEK' AND (((date_trunc('week',NEW."on")::date-date_trunc('week',anchor)::date)/7)%(cadence->>'every')::integer<>0 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(cadence->'weekdays') day WHERE day::integer=extract(isodow FROM NEW."on")::integer))
  OR cadence->>'kind'='MONTH' AND (months%(cadence->>'every')::integer<>0 OR cadence->>'missing_day' NOT IN('SKIP','LAST_DAY') OR cadence->>'missing_day'='SKIP' AND (cadence->>'day')::integer>month_end OR extract(day FROM NEW."on")::integer<>least((cadence->>'day')::integer,month_end))
 THEN RAISE EXCEPTION 'recurring company expense requires its actual due configured company plan and author';END IF;RETURN NEW;
END $$;
CREATE TRIGGER recurring_company_expense_source_guard BEFORE INSERT ON recurring_company_expense_occurrence FOR EACH ROW EXECUTE FUNCTION app_recurring_company_expense_guard();
COMMIT;
