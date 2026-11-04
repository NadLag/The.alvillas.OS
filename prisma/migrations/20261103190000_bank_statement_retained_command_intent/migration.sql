BEGIN;

-- Earlier admissions remain untouched. New requests retain their exact resumable intent.
CREATE FUNCTION app_bank_statement_admission_intent_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE intent jsonb; command_text text;
BEGIN
 intent:=NEW.policy_snapshot->'input';
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' OR NOT intent ?& ARRAY['accountId','format','fileSha256','fileSize','idempotencyKey','reviewFingerprint','reason']
  OR (SELECT count(*) FROM jsonb_object_keys(intent))<>7 OR intent->>'accountId' IS DISTINCT FROM NEW.ledger_account_id::text
  OR intent->>'format' IS DISTINCT FROM NEW.format OR intent->>'fileSha256' IS DISTINCT FROM NEW.file_sha256 OR intent->>'fileSize' IS DISTINCT FROM NEW.file_size::text
  OR intent->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text OR intent->>'reason' IS DISTINCT FROM NEW.reason
  OR COALESCE(intent->>'reviewFingerprint','') !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'bank statement admission requires its exact original resumable command intent'; END IF;
 command_text:=format('{"operation":"BANK_STATEMENT_IMPORT","input":{"accountId":%s,"format":%s,"fileSha256":%s,"fileSize":%s,"idempotencyKey":%s,"reviewFingerprint":%s,"reason":%s}}',
  intent->'accountId',intent->'format',intent->'fileSha256',intent->'fileSize',intent->'idempotencyKey',intent->'reviewFingerprint',intent->'reason');
 IF NEW.command_hash IS DISTINCT FROM encode(digest(convert_to(command_text,'UTF8'),'sha256'),'hex')
 THEN RAISE EXCEPTION 'bank statement command fingerprint must bind every original retained input'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_admission_intent_guard BEFORE INSERT ON bank_statement_admission FOR EACH ROW EXECUTE FUNCTION app_bank_statement_admission_intent_guard();

COMMIT;
