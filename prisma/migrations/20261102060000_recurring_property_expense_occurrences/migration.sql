BEGIN;
CREATE TABLE recurring_expense_occurrence (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(),organization_id uuid NOT NULL,schedule_id uuid NOT NULL,"on" date NOT NULL,
 config_rule_id uuid NOT NULL,expense_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT recurring_expense_occurrence_org_id_unique UNIQUE(organization_id,id),
 CONSTRAINT recurring_expense_occurrence_schedule_on_unique UNIQUE(organization_id,schedule_id,"on"),
 CONSTRAINT recurring_expense_occurrence_expense_unique UNIQUE(organization_id,expense_id),
 CONSTRAINT recurring_expense_occurrence_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT recurring_expense_occurrence_organization_id_config_rule_id_fkey FOREIGN KEY(organization_id,config_rule_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT recurring_expense_occurrence_organization_id_expense_id_fkey FOREIGN KEY(organization_id,expense_id) REFERENCES expense(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT recurring_expense_occurrence_organization_id_created_by_fkey FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT recurring_expense_occurrence_finite_date CHECK(isfinite("on"))
);
ALTER TABLE recurring_expense_occurrence ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_expense_occurrence FORCE ROW LEVEL SECURITY;
CREATE POLICY recurring_expense_occurrence_tenant_isolation ON recurring_expense_occurrence
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER recurring_expense_occurrence_immutable BEFORE UPDATE OR DELETE ON recurring_expense_occurrence
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_recurring_expense_occurrence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule;source expense;schedule jsonb;anchor date;cadence jsonb;months integer;month_end integer;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.config_rule_id;
 SELECT * INTO source FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.expense_id;
 SELECT item INTO schedule FROM jsonb_array_elements(rule.value->'expenses') item WHERE item->>'id'=NEW.schedule_id::text;
 anchor=(schedule->>'start_on')::date;cadence=schedule->'cadence';months=(extract(year FROM NEW."on")-extract(year FROM anchor))::integer*12+(extract(month FROM NEW."on")-extract(month FROM anchor))::integer;
 month_end=extract(day FROM date_trunc('month',NEW."on")+interval '1 month - 1 day')::integer;
 IF rule.id IS NULL OR rule.key<>'finance.recurring_expenses' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
  OR rule.value->>'source' IS DISTINCT FROM 'PROPERTY_EXPENSE_DRAFT' OR rule.value->>'principal' IS DISTINCT FROM 'CURRENT_CONFIGURATION_AUTHOR'
  OR rule.lifecycle<>'ACTIVE' OR rule.created_by IS DISTINCT FROM NEW.created_by OR rule.effective_from>NEW.created_at
  OR rule.effective_to IS NOT NULL AND rule.effective_to<=NEW.created_at
  OR source.id IS NULL OR source.state<>'DRAFT' OR source.created_by IS DISTINCT FROM NEW.created_by OR source.corrects_expense_id IS NOT NULL
  OR source.occurred_on IS DISTINCT FROM NEW."on" OR source.emergency OR source.reservation_id::text IS DISTINCT FROM schedule->'draft'->>'reservationId'
  OR source.property_id::text IS DISTINCT FROM schedule->'draft'->>'propertyId' OR source.funding_account_id::text IS DISTINCT FROM schedule->'draft'->>'fundingAccountId'
  OR source.amount IS DISTINCT FROM (schedule->'draft'->>'amount')::numeric OR source.currency::text IS DISTINCT FROM schedule->'draft'->>'currency'
  OR source.category IS DISTINCT FROM schedule->'draft'->>'category' OR source.purpose IS DISTINCT FROM schedule->'draft'->>'purpose'
  OR schedule IS NULL OR NEW."on"<(schedule->>'start_on')::date
  OR schedule->>'end_on' IS NOT NULL AND NEW."on">(schedule->>'end_on')::date
  OR cadence->>'kind' NOT IN('DAY','WEEK','MONTH') OR (cadence->>'every')::integer<1
  OR cadence->>'kind'='DAY' AND (NEW."on"-anchor)%(cadence->>'every')::integer<>0
  OR cadence->>'kind'='WEEK' AND (((date_trunc('week',NEW."on")::date-date_trunc('week',anchor)::date)/7)%(cadence->>'every')::integer<>0
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(cadence->'weekdays') day WHERE day::integer=extract(isodow FROM NEW."on")::integer))
  OR cadence->>'kind'='MONTH' AND (months%(cadence->>'every')::integer<>0
    OR cadence->>'missing_day' NOT IN('SKIP','LAST_DAY') OR cadence->>'missing_day'='SKIP' AND (cadence->>'day')::integer>month_end
    OR extract(day FROM NEW."on")::integer<>least((cadence->>'day')::integer,month_end))
 THEN RAISE EXCEPTION 'recurring expense occurrence requires its actual configured tenant draft and author';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recurring_expense_occurrence_source_guard BEFORE INSERT ON recurring_expense_occurrence
 FOR EACH ROW EXECUTE FUNCTION app_recurring_expense_occurrence_guard();
COMMIT;
