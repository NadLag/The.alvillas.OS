BEGIN;
-- Preserve the applied occurrence admission; make missing calendar fields fail closed.
CREATE OR REPLACE FUNCTION app_recurring_payout_draft_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p owner_payout%ROWTYPE; r config_rule%ROWTYPE; target jsonb; calendar jsonb; local_at timestamp;
BEGIN
 SELECT * INTO p FROM owner_payout WHERE organization_id=NEW.organization_id AND id=NEW.payout_id;
 SELECT * INTO r FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.config_rule_id;
 IF p.id IS NULL OR p.state<>'DRAFT' OR p.version<>1 OR p.transaction_id IS NOT NULL OR p.approved_at IS NOT NULL
  OR p.policy_snapshot IS NOT NULL OR p.reservation_id IS NOT NULL OR p.expected_settlement_at IS NOT NULL
  OR p.created_by<>NEW.created_by OR p.created_at<transaction_timestamp()
 THEN RAISE EXCEPTION 'recurring draft requires its actual new native unpaid draft'; END IF;
 IF r.id IS NULL OR r.key<>'finance.recurring_payout_drafts' OR r.scope_type<>'organization' OR r.scope_id IS NOT NULL
  OR r.created_by IS DISTINCT FROM NEW.created_by OR r.archived_at IS NOT NULL OR r.lifecycle NOT IN('ACTIVE','RETIRED')
  OR r.effective_from>NEW.created_at OR (r.effective_to IS NOT NULL AND r.effective_to<=NEW.created_at)
  OR r.value->>'source' IS DISTINCT FROM 'CURRENT_DERIVED_OWNER_PAYABLE'
  OR r.value->>'principal' IS DISTINCT FROM 'CURRENT_CONFIGURATION_AUTHOR'
  OR r.value->>'amount_source' IS DISTINCT FROM 'NATIVE_UNCOMMITTED_PAYABLE'
  OR r.value->>'missed_slots' IS DISTINCT FROM 'LATEST_DUE_SLOT'
  OR r.value->>'open_payouts' IS DISTINCT FROM 'WAIT_FOR_TERMINAL'
  OR EXISTS(SELECT 1 FROM config_rule n WHERE n.organization_id=r.organization_id AND n.key=r.key AND n.scope_type='organization' AND n.scope_id IS NULL
    AND n.archived_at IS NULL AND n.lifecycle IN('ACTIVE','RETIRED') AND n.effective_from<=NEW.created_at AND (n.effective_to IS NULL OR n.effective_to>NEW.created_at)
    AND (n.effective_from,n.version)>(r.effective_from,r.version))
 THEN RAISE EXCEPTION 'recurring draft requires its actual current authored configuration'; END IF;
 SELECT item INTO target FROM jsonb_array_elements(r.value->'targets') item WHERE item->>'id'=NEW.target_id::text;
 IF target IS NULL OR target->'draft'->>'ownerId' IS DISTINCT FROM p.owner_id::text
  OR target->'draft'->>'propertyId' IS DISTINCT FROM p.property_id::text OR target->'draft'->>'currency' IS DISTINCT FROM trim(p.currency)
  OR target->'draft'->>'payoutMethodId' IS DISTINCT FROM p.payout_method_id::text OR target->'draft'->>'fundingAccountId' IS DISTINCT FROM p.funding_account_id::text
  OR target->'draft'->>'purpose' IS DISTINCT FROM p.purpose OR target->>'starts_at' IS NULL OR (target->>'starts_at')::timestamptz>NEW.scheduled_at
 THEN RAISE EXCEPTION 'recurring draft requires its configured native target'; END IF;
 calendar=target->'calendar';local_at=NEW.scheduled_at AT TIME ZONE NEW.timezone;
 IF NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp() OR NEW.scheduled_at>NEW.created_at
  OR NEW.slot IS DISTINCT FROM to_char(local_at,'YYYY-MM-DD"T"HH24:MI:SS')
  OR NEW.timezone IS DISTINCT FROM coalesce(calendar->'schedule'->>'timezone',(SELECT timezone FROM property WHERE organization_id=p.organization_id AND id=p.property_id))
  OR coalesce(calendar->>'cadence','') NOT IN('WEEKLY','MONTHLY','FIFTEEN_DAY','CUSTOM_CRON')
  OR (calendar->>'cadence'='CUSTOM_CRON' AND coalesce(length(btrim(calendar->>'cron')),0)<5)
  OR (calendar->>'cadence'='FIFTEEN_DAY' AND calendar->'schedule'->>'anchor_on' IS NULL)
 THEN RAISE EXCEPTION 'recurring draft requires its actual due civil slot and creation clock'; END IF;
 IF calendar->>'cadence'<>'CUSTOM_CRON' AND (to_char(local_at,'HH24:MI') IS DISTINCT FROM calendar->'schedule'->>'at' OR extract(second FROM local_at)<>0)
 THEN RAISE EXCEPTION 'recurring draft requires its configured local clock'; END IF;
 IF (calendar->>'cadence'='WEEKLY' AND extract(dow FROM local_at)::integer IS DISTINCT FROM (calendar->'schedule'->>'weekday')::integer)
  OR (calendar->>'cadence'='MONTHLY' AND (CASE WHEN calendar->'schedule'->>'month_day'='LAST' THEN local_at::date<>(date_trunc('month',local_at)+interval '1 month - 1 day')::date
    ELSE extract(day FROM local_at)::integer IS DISTINCT FROM (calendar->'schedule'->>'month_day')::integer END))
  OR (calendar->>'cadence'='FIFTEEN_DAY' AND (local_at::date<(calendar->'schedule'->>'anchor_on')::date OR (local_at::date-(calendar->'schedule'->>'anchor_on')::date)%15<>0))
 THEN RAISE EXCEPTION 'recurring draft requires its configured calendar date'; END IF;
 IF NEW.evidence->>'schemaVersion' IS DISTINCT FROM '1' OR NEW.evidence->'nativeValidation'->>'payoutId' IS DISTINCT FROM p.id::text
  OR (NEW.evidence->'nativeValidation'->'amount'->>'amount')::numeric IS DISTINCT FROM p.amount
  OR NEW.evidence->'nativeValidation'->'amount'->>'currency' IS DISTINCT FROM trim(p.currency)
 THEN RAISE EXCEPTION 'recurring draft requires its native policy validation evidence'; END IF;
 RETURN NEW;
END $$;

COMMIT;
