BEGIN;
ALTER TABLE company_expense_revision ADD CONSTRAINT company_expense_revision_currency_fk FOREIGN KEY(currency) REFERENCES currency(code) ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE FUNCTION app_recurring_company_expense_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=NEW.organization_id AND resource_type='company_expense' AND resource_id=NEW.company_expense_id AND actor_id=NEW.created_by AND action='company_expense.recurring_generated' AND after->>'occurrenceId'=NEW.id::text AND after->>'scheduleId'=NEW.schedule_id::text AND after->>'on'=NEW."on"::text AND after->>'configRuleId'=NEW.config_rule_id::text AND occurred_at=NEW.created_at)
 THEN RAISE EXCEPTION 'company recurrence occurrence and native audit must commit atomically';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER recurring_company_expense_atomic_audit AFTER INSERT ON recurring_company_expense_occurrence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_recurring_company_expense_audit_guard();
COMMIT;
