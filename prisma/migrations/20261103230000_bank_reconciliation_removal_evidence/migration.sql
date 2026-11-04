BEGIN;
CREATE TABLE bank_reconciliation_evidence (
 organization_id UUID NOT NULL,
 entry_id UUID NOT NULL,
 line_id UUID NOT NULL,
 source_snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT bank_reconciliation_evidence_pkey PRIMARY KEY(organization_id,entry_id,line_id),
 CONSTRAINT bank_reconciliation_evidence_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT bank_reconciliation_evidence_organization_id_entry_id_fkey FOREIGN KEY(organization_id,entry_id) REFERENCES bank_reconciliation_entry(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT bank_reconciliation_evidence_organization_id_line_id_fkey FOREIGN KEY(organization_id,line_id) REFERENCES bank_statement_line(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX bank_reconciliation_evidence_line_idx ON bank_reconciliation_evidence(organization_id,line_id);
ALTER TABLE bank_reconciliation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliation_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_reconciliation_evidence_tenant_isolation ON bank_reconciliation_evidence
 USING(organization_id=current_setting('app.current_organization_id',true)::uuid)
 WITH CHECK(organization_id=current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER bank_reconciliation_evidence_immutable BEFORE UPDATE OR DELETE ON bank_reconciliation_evidence FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();


CREATE FUNCTION app_bank_statement_line_is_terminal(org_uuid uuid,line_uuid uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH RECURSIVE ancestors AS (
  SELECT l.id,l.ledger_account_id,l.bank_identity_hash,l.currency,l.external_id,l.corrects_external_id,l.correction_action,ARRAY[l.id] AS path,false AS cycle
  FROM bank_statement_line l WHERE l.organization_id=org_uuid AND l.id=line_uuid
  UNION ALL
  SELECT p.id,p.ledger_account_id,p.bank_identity_hash,p.currency,p.external_id,p.corrects_external_id,p.correction_action,a.path||p.id,p.id=ANY(a.path)
  FROM ancestors a JOIN bank_statement_line p ON p.organization_id=org_uuid AND p.ledger_account_id=a.ledger_account_id
   AND p.bank_identity_hash=a.bank_identity_hash AND p.external_id=a.corrects_external_id WHERE NOT a.cycle
 ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=line_uuid)
 AND NOT EXISTS(SELECT 1 FROM ancestors a WHERE a.cycle
  OR (a.id<>line_uuid AND a.correction_action='DELETE')
  OR a.currency IS DISTINCT FROM (SELECT currency FROM bank_statement_line WHERE organization_id=org_uuid AND id=line_uuid)
  OR (a.corrects_external_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bank_statement_line p WHERE p.organization_id=org_uuid
    AND p.ledger_account_id=a.ledger_account_id AND p.bank_identity_hash=a.bank_identity_hash AND p.external_id=a.corrects_external_id))
  OR (SELECT count(*) FROM bank_statement_line c WHERE c.organization_id=org_uuid AND c.ledger_account_id=a.ledger_account_id
    AND c.bank_identity_hash=a.bank_identity_hash AND c.corrects_external_id=a.external_id)>1)
 AND NOT EXISTS(SELECT 1 FROM bank_statement_line l JOIN bank_statement_line c ON c.organization_id=l.organization_id AND c.ledger_account_id=l.ledger_account_id
   AND c.bank_identity_hash=l.bank_identity_hash AND c.corrects_external_id=l.external_id WHERE l.organization_id=org_uuid AND l.id=line_uuid)
$$;

CREATE OR REPLACE FUNCTION app_bank_statement_line_is_current(org_uuid uuid,line_uuid uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT app_bank_statement_line_is_terminal(org_uuid,line_uuid) AND EXISTS(SELECT 1 FROM bank_statement_line WHERE organization_id=org_uuid AND id=line_uuid AND correction_action IS DISTINCT FROM 'DELETE')
$$;
CREATE FUNCTION app_bank_statement_line_is_removed(org_uuid uuid,line_uuid uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT app_bank_statement_line_is_terminal(org_uuid,line_uuid) AND EXISTS(SELECT 1 FROM bank_statement_line WHERE organization_id=org_uuid AND id=line_uuid AND correction_action='DELETE')
$$;

CREATE OR REPLACE FUNCTION app_bank_reconciliation_command_text(intent jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE intent->>'action' WHEN 'MATCH' THEN format('{"action":%s,"accountId":%s,"currency":%s,"expected":[%s],"actual":[%s],"reason":%s,"varianceAction":%s%s,"idempotencyKey":%s,"reviewFingerprint":%s}',
 intent->'action',intent->'accountId',intent->'currency',
 (SELECT string_agg(format('{"id":%s,"amount":%s}',v->'id',v->'amount'),',' ORDER BY ordinal) FROM jsonb_array_elements(intent->'expected') WITH ORDINALITY AS items(v,ordinal)),
 (SELECT string_agg(format('{"id":%s,"amount":%s}',v->'id',v->'amount'),',' ORDER BY ordinal) FROM jsonb_array_elements(intent->'actual') WITH ORDINALITY AS items(v,ordinal)),
 intent->'reason',intent->'varianceAction',CASE WHEN intent ? 'evidence' THEN ',"evidence":['||(SELECT COALESCE(string_agg(v::text,',' ORDER BY ordinal),'') FROM jsonb_array_elements(intent->'evidence') WITH ORDINALITY AS items(v,ordinal))||']' ELSE '' END,intent->'idempotencyKey',intent->'reviewFingerprint')
 WHEN 'RELEASE' THEN format('{"action":%s,"id":%s,"idempotencyKey":%s,"reason":%s}',intent->'action',intent->'id',intent->'idempotencyKey',intent->'reason') END
$$;

CREATE OR REPLACE FUNCTION app_assert_bank_reconciliation(org_uuid uuid,entry_uuid uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE e bank_reconciliation_entry; previous bank_reconciliation_entry; a bank_reconciliation_allocation; b bank_reconciliation_evidence; removal_mode boolean; evidence_plan jsonb;
 p posting; t financial_transaction; l bank_statement_line; account ledger_account; rule config_rule; selected uuid; binding jsonb;
 native_snapshot jsonb; expected_plan jsonb; actual_plan jsonb; expected_total numeric; actual_total numeric; tolerance numeric; variance numeric; prior numeric; minor integer;
BEGIN
 SELECT * INTO e FROM bank_reconciliation_entry WHERE organization_id=org_uuid AND id=entry_uuid;
 IF e.id IS NULL THEN RAISE EXCEPTION 'actual reconciliation entry required'; END IF;
 IF e.input->>'action' IS DISTINCT FROM e.action OR e.input->>'idempotencyKey' IS DISTINCT FROM e.idempotency_key::text
  OR e.input->>'reason' IS DISTINCT FROM e.reason OR e.command_hash IS DISTINCT FROM encode(digest(convert_to(app_bank_reconciliation_command_text(e.input),'UTF8'),'sha256'),'hex')
 THEN RAISE EXCEPTION 'reconciliation must retain its complete exact command intent'; END IF;
 removal_mode:=e.input ? 'evidence';
 IF e.action='RELEASE' THEN
  SELECT * INTO previous FROM bank_reconciliation_entry WHERE organization_id=org_uuid AND id=e.previous_entry_id;
  IF previous.id IS NULL OR previous.action<>'MATCH' OR e.input->>'id' IS DISTINCT FROM previous.id::text
   OR (SELECT count(*) FROM jsonb_object_keys(e.input))<>4 OR e.ledger_account_id<>previous.ledger_account_id OR e.currency<>previous.currency
   OR e.snapshot IS DISTINCT FROM previous.snapshot OR e.policy_snapshot IS DISTINCT FROM previous.policy_snapshot
   OR EXISTS(SELECT 1 FROM bank_reconciliation_allocation WHERE organization_id=org_uuid AND entry_id=e.id)
   OR EXISTS(SELECT 1 FROM bank_reconciliation_evidence WHERE organization_id=org_uuid AND entry_id=e.id)
   OR NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=org_uuid AND resource_type='bank_statement' AND resource_id=e.id AND actor_id=e.actor_id
    AND action='finance.bank_reconciliation.released' AND reason=e.reason
    AND after=jsonb_build_object('id',e.id,'originalId',previous.id,'accountId',e.ledger_account_id,'commandHash',e.command_hash))
  THEN RAISE EXCEPTION 'release must retain the exact original association and atomic audit without changing money'; END IF;
  RETURN;
 END IF;
 SELECT * INTO account FROM ledger_account WHERE organization_id=org_uuid AND id=e.ledger_account_id;
 SELECT * INTO rule FROM config_rule WHERE organization_id=org_uuid AND id::text=e.policy_snapshot->>'id';
 SELECT id INTO selected FROM config_rule WHERE organization_id=org_uuid AND key='finance.bank_statements' AND scope_type='organization' AND scope_id IS NULL
  AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=clock_timestamp() AND(effective_to IS NULL OR effective_to>clock_timestamp()) ORDER BY effective_from DESC,version DESC LIMIT 1;
 SELECT item INTO binding FROM jsonb_array_elements(rule.value->'accounts') item WHERE item->>'account_code'=account.code;
 SELECT minor_unit INTO minor FROM currency WHERE code=e.currency;
 IF account.id IS NULL OR account.archived_at IS NOT NULL OR account.account_type<>'ASSET_LOCATION' OR account.normal_side<>'DEBIT'
  OR EXISTS(SELECT 1 FROM team_wallet WHERE organization_id=org_uuid AND ledger_account_id=account.id)
  OR rule.id IS NULL OR rule.id IS DISTINCT FROM selected OR e.policy_snapshot->>'version' IS DISTINCT FROM rule.version::text
  OR e.policy_snapshot->'matching' IS DISTINCT FROM rule.value->'matching' OR binding IS NULL OR binding->>'currency' IS DISTINCT FROM e.currency
  OR e.policy_snapshot->>'bankIdentityHash' IS DISTINCT FROM encode(digest(convert_to('['||to_json(binding->>'bank_id')::text||','||COALESCE(to_json(binding->>'branch_id')::text,'null')||','||to_json(binding->>'account_id')::text||']','UTF8'),'sha256'),'hex')
  OR rule.value->'matching'->>'admission' IS DISTINCT FROM 'EXPLICIT_REVIEW' OR rule.value->'matching'->>'ledger_effect' IS DISTINCT FROM 'NONE'
  OR minor IS NULL OR minor>2 OR e.input->>'accountId' IS DISTINCT FROM e.ledger_account_id::text OR e.input->>'currency' IS DISTINCT FROM e.currency
  OR COALESCE(e.input->>'reviewFingerprint','') !~ '^[a-f0-9]{64}$' OR (SELECT count(*) FROM jsonb_object_keys(e.input))<>(CASE WHEN removal_mode THEN 10 ELSE 9 END)
  OR e.snapshot->>'unit' IS DISTINCT FROM 'MONEY:'||e.currency OR e.snapshot->>'reason' IS DISTINCT FROM e.reason

 THEN RAISE EXCEPTION 'reconciliation requires the actual bank and current explicit nonposting policy'; END IF;
 IF removal_mode THEN
  IF jsonb_typeof(e.input->'evidence') IS DISTINCT FROM 'array' OR jsonb_array_length(e.input->'evidence') NOT BETWEEN 1 AND 500
   OR e.input->'actual' IS DISTINCT FROM '[]'::jsonb OR EXISTS(SELECT 1 FROM bank_reconciliation_allocation WHERE organization_id=org_uuid AND entry_id=e.id AND line_id IS NOT NULL)
  THEN RAISE EXCEPTION 'bank removal evidence cannot invent an actual monetary allocation'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM bank_reconciliation_evidence WHERE organization_id=org_uuid AND entry_id=e.id)
   OR e.snapshot->'evidence' IS DISTINCT FROM '[]'::jsonb
  THEN RAISE EXCEPTION 'ordinary bank movements cannot acquire removal evidence'; END IF;
 END IF;
 FOR b IN SELECT * FROM bank_reconciliation_evidence WHERE organization_id=org_uuid AND entry_id=e.id LOOP
  SELECT * INTO l FROM bank_statement_line WHERE organization_id=org_uuid AND id=b.line_id;
  native_snapshot:=jsonb_build_object('id',l.id,'factHash',l.fact_hash,'bankIdentityHash',l.bank_identity_hash);
  IF l.id IS NULL OR l.ledger_account_id<>e.ledger_account_id OR l.currency<>e.currency OR l.bank_identity_hash::text IS DISTINCT FROM e.policy_snapshot->>'bankIdentityHash'
   OR b.source_snapshot IS DISTINCT FROM native_snapshot OR NOT app_bank_statement_line_is_removed(org_uuid,l.id)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.input->'evidence') item WHERE item=to_jsonb(l.id::text))
  THEN RAISE EXCEPTION 'reconciliation evidence must retain the exact current unambiguous bank removal'; END IF;
  IF EXISTS(WITH RECURSIVE ancestors AS (
   SELECT id,ledger_account_id,bank_identity_hash,external_id,corrects_external_id FROM bank_statement_line WHERE organization_id=org_uuid AND id=l.id
   UNION
   SELECT parent.id,parent.ledger_account_id,parent.bank_identity_hash,parent.external_id,parent.corrects_external_id
   FROM bank_statement_line parent JOIN ancestors child ON parent.organization_id=org_uuid AND parent.ledger_account_id=child.ledger_account_id
    AND parent.bank_identity_hash=child.bank_identity_hash AND parent.external_id=child.corrects_external_id
  ) SELECT 1 FROM ancestors original JOIN bank_reconciliation_allocation allocation ON allocation.organization_id=org_uuid AND allocation.line_id=original.id
   JOIN bank_reconciliation_entry entry ON entry.organization_id=org_uuid AND entry.id=allocation.entry_id
   WHERE entry.action='MATCH' AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_entry released WHERE released.organization_id=org_uuid AND released.previous_entry_id=entry.id)
   UNION ALL
   SELECT 1 FROM ancestors original JOIN bank_reconciliation_evidence evidence ON evidence.organization_id=org_uuid AND evidence.line_id=original.id AND evidence.entry_id<>e.id
   JOIN bank_reconciliation_entry entry ON entry.organization_id=org_uuid AND entry.id=evidence.entry_id
   WHERE entry.action='MATCH' AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_entry released WHERE released.organization_id=org_uuid AND released.previous_entry_id=entry.id))
  THEN RAISE EXCEPTION 'bank removal requires release of every active original family association'; END IF;
 END LOOP;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('side','ACTUAL','sourceKey',l.id,'fingerprint',l.fact_hash) ORDER BY l.id),'[]'::jsonb) INTO evidence_plan
  FROM bank_reconciliation_evidence evidence JOIN bank_statement_line l ON l.organization_id=evidence.organization_id AND l.id=evidence.line_id
  WHERE evidence.organization_id=org_uuid AND evidence.entry_id=e.id;
 IF e.snapshot->'evidence' IS DISTINCT FROM evidence_plan OR (removal_mode AND jsonb_array_length(evidence_plan) IS DISTINCT FROM jsonb_array_length(e.input->'evidence'))
 THEN RAISE EXCEPTION 'every retained removal must occur once in the exact source evidence plan'; END IF;

 FOR a IN SELECT * FROM bank_reconciliation_allocation WHERE organization_id=org_uuid AND entry_id=e.id LOOP
  IF a.amount<>round(a.amount,minor) OR a.allocated_before<>round(a.allocated_before,minor) OR a.original_amount<>round(a.original_amount,minor)
  THEN RAISE EXCEPTION 'reconciliation must preserve exact currency precision'; END IF;
  SELECT COALESCE(sum(other.amount),0) INTO prior FROM bank_reconciliation_allocation other JOIN bank_reconciliation_entry parent ON parent.organization_id=other.organization_id AND parent.id=other.entry_id
   WHERE other.organization_id=org_uuid AND other.entry_id<>e.id AND (other.posting_id=a.posting_id OR other.line_id=a.line_id)
    AND parent.action='MATCH' AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_entry release WHERE release.organization_id=org_uuid AND release.previous_entry_id=parent.id);
  IF a.allocated_before IS DISTINCT FROM prior OR a.amount+prior>abs(a.original_amount) THEN RAISE EXCEPTION 'original reconciliation source budget exceeded'; END IF;
  IF a.posting_id IS NOT NULL THEN
   SELECT * INTO p FROM posting WHERE organization_id=org_uuid AND id=a.posting_id;
   SELECT * INTO t FROM financial_transaction WHERE organization_id=org_uuid AND id=p.transaction_id;
   native_snapshot:=jsonb_build_object('id',p.id,'transactionId',t.id,'reference',t.reference,'side',p.side,'amount',p.amount::text,'currency',p.currency,
    'reversalIds',COALESCE((SELECT jsonb_agg(id::text ORDER BY id) FROM financial_transaction WHERE organization_id=org_uuid AND reverses_transaction_id=t.id),'[]'::jsonb));
   IF p.id IS NULL OR t.id IS NULL OR NOT t.sealed OR p.ledger_account_id<>e.ledger_account_id OR p.currency<>e.currency
    OR a.original_amount IS DISTINCT FROM (CASE p.side WHEN 'DEBIT' THEN p.amount WHEN 'CREDIT' THEN -p.amount END) OR a.source_snapshot IS DISTINCT FROM native_snapshot
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.input->'expected') item WHERE item=jsonb_build_object('id',p.id,'amount',a.amount::text))
   THEN RAISE EXCEPTION 'reconciliation expected source must be its exact original bank posting'; END IF;
  ELSE
   SELECT * INTO l FROM bank_statement_line WHERE organization_id=org_uuid AND id=a.line_id;
   native_snapshot:=jsonb_build_object('id',l.id,'factHash',l.fact_hash,'bankIdentityHash',l.bank_identity_hash);
   IF l.id IS NULL OR l.ledger_account_id<>e.ledger_account_id OR l.currency<>e.currency OR l.bank_identity_hash::text IS DISTINCT FROM e.policy_snapshot->>'bankIdentityHash'
    OR a.original_amount IS DISTINCT FROM l.amount OR a.source_snapshot IS DISTINCT FROM native_snapshot OR NOT app_bank_statement_line_is_current(org_uuid,l.id)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.input->'actual') item WHERE item=jsonb_build_object('id',l.id,'amount',a.amount::text))
   THEN RAISE EXCEPTION 'reconciliation actual source must be its exact current retained bank fact'; END IF;
  END IF;
 END LOOP;
 SELECT COALESCE(sum(CASE WHEN original_amount<0 THEN -amount ELSE amount END),0),
  COALESCE(jsonb_agg(jsonb_build_object('sourceKey',posting_id,'original',original_amount::text,'allocatedBefore',allocated_before::text,'amount',amount::text) ORDER BY posting_id),'[]'::jsonb)
  INTO expected_total,expected_plan FROM bank_reconciliation_allocation WHERE organization_id=org_uuid AND entry_id=e.id AND posting_id IS NOT NULL;
 SELECT COALESCE(sum(CASE WHEN original_amount<0 THEN -amount ELSE amount END),0),
  COALESCE(jsonb_agg(jsonb_build_object('sourceKey',line_id,'original',original_amount::text,'allocatedBefore',allocated_before::text,'amount',amount::text) ORDER BY line_id),'[]'::jsonb)
  INTO actual_total,actual_plan FROM bank_reconciliation_allocation WHERE organization_id=org_uuid AND entry_id=e.id AND line_id IS NOT NULL;
 actual_total:=actual_total+0.00;
 tolerance:=(rule.value->'matching'->>'amount_tolerance')::numeric; variance:=actual_total-expected_total;
 IF jsonb_array_length(expected_plan) NOT BETWEEN 1 AND 500 OR jsonb_array_length(actual_plan) NOT BETWEEN (CASE WHEN removal_mode THEN 0 ELSE 1 END) AND 500
  OR jsonb_array_length(expected_plan) IS DISTINCT FROM jsonb_array_length(e.input->'expected') OR jsonb_array_length(actual_plan) IS DISTINCT FROM jsonb_array_length(e.input->'actual')
  OR e.snapshot->'allocations' IS DISTINCT FROM jsonb_build_object('expected',expected_plan,'actual',actual_plan)
  OR e.snapshot->>'expected' IS DISTINCT FROM expected_total::text OR e.snapshot->>'actual' IS DISTINCT FROM actual_total::text OR e.snapshot->>'variance' IS DISTINCT FROM variance::text
  OR tolerance<0 OR tolerance<>round(tolerance,minor)
  OR e.snapshot->>'classification' IS DISTINCT FROM (CASE WHEN variance=0 THEN 'EXACT' WHEN abs(variance)<=tolerance THEN 'WITHIN_TOLERANCE' ELSE 'OUTSIDE_TOLERANCE' END)
  OR (variance=0 AND e.snapshot->'varianceAction' IS DISTINCT FROM 'null'::jsonb)
  OR (variance<>0 AND (length(btrim(COALESCE(e.input->>'varianceAction',''))) NOT BETWEEN 8 AND 2000 OR e.snapshot->'varianceAction' IS DISTINCT FROM e.input->'varianceAction'))
  OR NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=org_uuid AND resource_type='bank_statement' AND resource_id=e.id AND actor_id=e.actor_id AND action='finance.bank_reconciliation.matched' AND reason=e.reason
    AND after=jsonb_build_object('id',e.id,'accountId',e.ledger_account_id,'commandHash',e.command_hash,'plan',e.snapshot))
 THEN RAISE EXCEPTION 'reconciliation must retain exact expected, actual, variance, reason, action and atomic audit'; END IF;
END $$;

CREATE CONSTRAINT TRIGGER bank_reconciliation_evidence_guard AFTER INSERT ON bank_reconciliation_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_bank_reconciliation_guard();

COMMIT;

