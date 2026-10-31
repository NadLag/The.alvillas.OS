BEGIN;
-- Strengthen canonical receipt admission without rewriting earlier SQL or financial history.
CREATE OR REPLACE FUNCTION app_employee_settlement_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target financial_transaction%ROWTYPE; journal_uuid uuid; intent jsonb;
BEGIN
 IF NEW.action='finance.employee_settlement.posted' THEN
  intent=NEW.after->'input';
  IF jsonb_typeof(NEW.after) IS DISTINCT FROM 'object' OR NOT(NEW.after ?& ARRAY['input','recognitionId','transactionId','sourcePeriodId','sourcePeriodEventId','postedAt'])
   OR (SELECT count(*) FROM jsonb_object_keys(NEW.after))<>6 OR jsonb_typeof(intent) IS DISTINCT FROM 'object'
   OR NOT(intent ?& ARRAY['id','claimId','kind','fundingAccountId','idempotencyKey','amount','currency','paidAt','reference','currentPeriod','reason'])
   OR (SELECT count(*) FROM jsonb_object_keys(intent))<>11
   OR EXISTS(SELECT 1 FROM jsonb_each(intent) e WHERE e.key IN ('id','claimId','kind','fundingAccountId','idempotencyKey','amount','currency','paidAt','reason') AND jsonb_typeof(e.value) IS DISTINCT FROM 'string')
   OR jsonb_typeof(intent->'currentPeriod') IS DISTINCT FROM 'boolean'
   OR (jsonb_typeof(intent->'reference') IS DISTINCT FROM 'null' AND jsonb_typeof(intent->'reference') IS DISTINCT FROM 'string')
   OR (intent->>'kind' IS DISTINCT FROM 'PAYMENT' AND intent->>'kind' IS DISTINCT FROM 'WALLET_OFFSET')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['id','claimId','fundingAccountId','idempotencyKey']) k WHERE (intent->>k) IS DISTINCT FROM ((intent->>k)::uuid)::text)
   OR intent->>'reason' IS DISTINCT FROM btrim(intent->>'reason')
   OR (jsonb_typeof(intent->'reference')='string' AND (intent->>'reference'='' OR intent->>'reference' IS DISTINCT FROM btrim(intent->>'reference')))
   OR intent->>'paidAt' IS DISTINCT FROM to_char((intent->>'paidAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  THEN RAISE EXCEPTION 'employee settlement receipt requires exact canonical typed intent';END IF;
  journal_uuid=NEW.resource_id;
 ELSIF NEW.action='finance.employee_settlement.reversed' THEN
  IF jsonb_typeof(NEW.after) IS DISTINCT FROM 'object' OR NOT(NEW.after ?& ARRAY['submissionId','claimId','originalTransactionIds','reversalTransactionIds'])
   OR (SELECT count(*) FROM jsonb_object_keys(NEW.after))<>4
   OR jsonb_typeof(NEW.after->'submissionId') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.after->'claimId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(NEW.after->'originalTransactionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.after->'originalTransactionIds')<>1
   OR jsonb_typeof(NEW.after->'reversalTransactionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.after->'reversalTransactionIds')<>1
   OR NEW.reason IS DISTINCT FROM btrim(NEW.reason) OR length(btrim(NEW.reason)) NOT BETWEEN 6 AND 500
  THEN RAISE EXCEPTION 'employee reversal requires its exact canonical source and new journal';END IF;
  journal_uuid=(NEW.after#>>'{reversalTransactionIds,0}')::uuid;
 ELSE RETURN NEW;END IF;
 SELECT * INTO target FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=journal_uuid;
 IF NEW.resource_type IS DISTINCT FROM 'financial_transaction' OR target.id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=journal_uuid AND t.xmin::text=pg_current_xact_id()::text)
 THEN RAISE EXCEPTION 'employee settlement receipt belongs to its actual new journal';END IF;
 PERFORM app_assert_employee_settlement(NEW.organization_id,target.id);RETURN NEW;
END $$;
COMMIT;
