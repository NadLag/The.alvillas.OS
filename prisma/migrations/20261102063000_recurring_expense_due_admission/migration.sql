BEGIN;
-- Admission must use the actual current policy and property clock, even for a direct database writer.
-- The original occurrence/source guard and all financial posting guards remain unchanged.
CREATE FUNCTION app_recurring_expense_due_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE current_rule config_rule;schedule jsonb;timezone_name text;local_clock timestamp;actual_now timestamptz;
BEGIN
 actual_now=clock_timestamp();
 SELECT * INTO current_rule FROM config_rule
  WHERE organization_id=NEW.organization_id AND key='finance.recurring_expenses' AND scope_type='organization' AND scope_id IS NULL
   AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=actual_now AND (effective_to IS NULL OR effective_to>actual_now)
  ORDER BY effective_from DESC,version DESC LIMIT 1;
 SELECT item INTO schedule FROM jsonb_array_elements(current_rule.value->'expenses') item WHERE item->>'id'=NEW.schedule_id::text;
 SELECT property.timezone INTO timezone_name FROM expense JOIN property ON property.organization_id=expense.organization_id AND property.id=expense.property_id
  WHERE expense.organization_id=NEW.organization_id AND expense.id=NEW.expense_id AND property.archived_at IS NULL;
 IF timezone_name IS NULL OR current_rule.id IS DISTINCT FROM NEW.config_rule_id OR current_rule.lifecycle<>'ACTIVE' OR schedule IS NULL
  OR NEW.created_at>actual_now
 THEN RAISE EXCEPTION 'recurring expense admission requires its current policy, property and actual clock';END IF;
 local_clock=actual_now AT TIME ZONE timezone_name;
 IF NEW."on">local_clock::date OR NEW."on"=local_clock::date AND local_clock::time<(schedule->>'run_at')::time
 THEN RAISE EXCEPTION 'recurring expense occurrence is not due in its property calendar';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recurring_expense_due_admission_guard BEFORE INSERT ON recurring_expense_occurrence
 FOR EACH ROW EXECUTE FUNCTION app_recurring_expense_due_guard();
COMMIT;
