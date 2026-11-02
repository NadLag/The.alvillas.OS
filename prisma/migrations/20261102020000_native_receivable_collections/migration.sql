BEGIN;
-- CreateTable
CREATE TABLE "receivable_collection" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "destination_account_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method" VARCHAR(120) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "external_reference" VARCHAR(160),
    "purpose" VARCHAR(1000) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "source_policy_rule_id" UUID NOT NULL,
    "collection_policy_rule_id" UUID NOT NULL,
    "calendar_policy_rule_id" UUID NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receivable_collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_collection_reversal" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "collection_policy_rule_id" UUID NOT NULL,
    "calendar_policy_rule_id" UUID NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receivable_collection_reversal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receivable_collection_assignment_idx" ON "receivable_collection"("organization_id", "assignment_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "receivable_collection_destination_idx" ON "receivable_collection"("organization_id", "destination_account_id", "received_at", "id");

-- CreateIndex
CREATE INDEX "receivable_collection_currency_idx" ON "receivable_collection"("organization_id", "currency", "received_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_collection_org_id" ON "receivable_collection"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_collection_journal_unique" ON "receivable_collection"("organization_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_collection_org_key" ON "receivable_collection"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "receivable_collection_reversal_created_idx" ON "receivable_collection_reversal"("organization_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_collection_reversal_org_id" ON "receivable_collection_reversal"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_collection_reversal_original_unique" ON "receivable_collection_reversal"("organization_id", "collection_id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_collection_reversal_journal_unique" ON "receivable_collection_reversal"("organization_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_collection_reversal_org_key" ON "receivable_collection_reversal"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "receivable_collection" ADD CONSTRAINT "receivable_collection_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection" ADD CONSTRAINT "receivable_collection_organization_id_assignment_id_fkey" FOREIGN KEY ("organization_id", "assignment_id") REFERENCES "receivable_assignment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection" ADD CONSTRAINT "receivable_collection_organization_id_transaction_id_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection" ADD CONSTRAINT "receivable_collection_organization_id_destination_account__fkey" FOREIGN KEY ("organization_id", "destination_account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection" ADD CONSTRAINT "receivable_collection_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection" ADD CONSTRAINT "receivable_collection_organization_id_source_policy_rule_i_fkey" FOREIGN KEY ("organization_id", "source_policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection" ADD CONSTRAINT "receivable_collection_organization_id_collection_policy_ru_fkey" FOREIGN KEY ("organization_id", "collection_policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection" ADD CONSTRAINT "receivable_collection_organization_id_calendar_policy_rule_fkey" FOREIGN KEY ("organization_id", "calendar_policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection" ADD CONSTRAINT "receivable_collection_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection_reversal" ADD CONSTRAINT "receivable_collection_reversal_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection_reversal" ADD CONSTRAINT "receivable_collection_reversal_original_fk" FOREIGN KEY ("organization_id", "collection_id") REFERENCES "receivable_collection"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection_reversal" ADD CONSTRAINT "receivable_collection_reversal_organization_id_transaction_fkey" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection_reversal" ADD CONSTRAINT "receivable_collection_reversal_policy_fk" FOREIGN KEY ("organization_id", "collection_policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection_reversal" ADD CONSTRAINT "receivable_collection_reversal_organization_id_calendar_po_fkey" FOREIGN KEY ("organization_id", "calendar_policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_collection_reversal" ADD CONSTRAINT "receivable_collection_reversal_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE receivable_collection ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_collection FORCE ROW LEVEL SECURITY;
CREATE POLICY receivable_collection_tenant_isolation ON receivable_collection
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE receivable_collection_reversal ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_collection_reversal FORCE ROW LEVEL SECURITY;
CREATE POLICY receivable_collection_reversal_tenant_isolation ON receivable_collection_reversal
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER receivable_collection_immutable BEFORE UPDATE OR DELETE ON receivable_collection
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER receivable_collection_reversal_immutable BEFORE UPDATE OR DELETE ON receivable_collection_reversal
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

ALTER TABLE receivable_collection ADD CONSTRAINT receivable_collection_intent CHECK((
 amount>0 AND amount NOT IN('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND currency~'^[A-Z]{3}$'
 AND isfinite(received_at) AND date_trunc('milliseconds',received_at)=received_at
 AND length(btrim(purpose))>=3 AND length(btrim(reason))>=6
 AND request_fingerprint~'^[a-f0-9]{64}$' AND review_fingerprint~'^[a-f0-9]{64}$'
 AND jsonb_typeof(source_snapshot)='object' AND source_snapshot->>'schemaVersion'='1'
 AND jsonb_typeof(policy_snapshot)='object' AND policy_snapshot->>'schemaVersion'='1'
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
) IS TRUE);
ALTER TABLE receivable_collection_reversal ADD CONSTRAINT receivable_collection_reversal_intent CHECK((
 length(btrim(reason))>=6 AND request_fingerprint~'^[a-f0-9]{64}$' AND review_fingerprint~'^[a-f0-9]{64}$'
 AND jsonb_typeof(source_snapshot)='object' AND source_snapshot->>'schemaVersion'='1'
 AND jsonb_typeof(policy_snapshot)='object' AND policy_snapshot->>'schemaVersion'='1'
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
) IS TRUE);

CREATE FUNCTION app_receivable_collection_movements(org_uuid uuid,assignment_uuid uuid,currency_code text,except_collection uuid DEFAULT NULL)
 RETURNS TABLE(collected numeric,fingerprint text) LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 WITH sources AS MATERIALIZED(
  SELECT c.id,c.transaction_id,p.ledger_account_id FROM receivable_collection c
  JOIN receivable_assignment a ON a.organization_id=c.organization_id AND a.id=c.assignment_id
  JOIN posting p ON p.organization_id=a.organization_id AND p.id=a.posting_id
  WHERE c.organization_id=org_uuid AND c.assignment_id=assignment_uuid AND(except_collection IS NULL OR c.id<>except_collection)
 ),journals AS MATERIALIZED(
  SELECT s.id collection_id,s.ledger_account_id,t.id,t.reverses_transaction_id,t.occurred_at FROM sources s
  JOIN financial_transaction t ON t.organization_id=org_uuid AND t.id=s.transaction_id
  UNION ALL
  SELECT s.id,s.ledger_account_id,t.id,t.reverses_transaction_id,t.occurred_at FROM sources s
  JOIN financial_transaction t ON t.organization_id=org_uuid AND t.reverses_transaction_id=s.transaction_id
 )
 SELECT COALESCE(sum(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END),0),
  encode(sha256(convert_to(COALESCE(string_agg(concat_ws(':',j.collection_id,j.id,p.id,p.side,p.amount::text,p.currency,j.reverses_transaction_id,p.ledger_account_id,
   to_char(j.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),',' ORDER BY j.id,p.id),''),'UTF8')),'hex')
 FROM journals j JOIN posting p ON p.organization_id=org_uuid AND p.transaction_id=j.id AND p.ledger_account_id=j.ledger_account_id AND p.currency=currency_code;
$$;

CREATE FUNCTION app_receivable_collection_source(org_uuid uuid,assignment_uuid uuid,destination_uuid uuid) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 SELECT jsonb_build_object('schemaVersion',1,
  'assignment',jsonb_build_object('id',a.id::text,'postingId',a.posting_id::text,'party',jsonb_build_object('kind',a.party_kind,'id',COALESCE(a.guest_id,a.owner_id,a.supplier_id,a.person_id)::text),
   'amount',jsonb_build_object('amount',a.amount::text,'currency',a.currency),'dueOn',a.due_on::text,'purpose',a.purpose,'reason',a.reason,'createdBy',a.created_by::text,
   'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'release',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id::text,'reason',r.reason,'createdBy',r.created_by::text,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END),
  'original',app_receivable_original_source(org_uuid,a.posting_id),
  'destination',jsonb_build_object('id',k.id::text,'organizationId',k.organization_id::text,'code',k.code,'name',k.name,'accountType',k.account_type,'normalSide',k.normal_side,
   'archivedAt',to_char(k.archived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'teamWallet',CASE WHEN w.id IS NULL THEN NULL ELSE jsonb_build_object('id',w.id::text,'personId',w.person_id::text,'person',jsonb_build_object('archivedAt',to_char(person.archived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) END))
 FROM receivable_assignment a
 JOIN ledger_account k ON k.organization_id=a.organization_id AND k.id=destination_uuid
 LEFT JOIN receivable_assignment_release r ON r.organization_id=a.organization_id AND r.assignment_id=a.id
 LEFT JOIN team_wallet w ON w.organization_id=k.organization_id AND w.ledger_account_id=k.id
 LEFT JOIN person ON person.organization_id=w.organization_id AND person.id=w.person_id
 WHERE a.organization_id=org_uuid AND a.id=assignment_uuid;
$$;

CREATE FUNCTION app_receivable_collection_policies(org_uuid uuid,source_uuid uuid,collection_uuid uuid,calendar_uuid uuid,at_time timestamptz) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 WITH effective AS MATERIALIZED(
  SELECT DISTINCT ON(key) * FROM config_rule WHERE organization_id=org_uuid AND scope_type='organization' AND scope_id IS NULL
   AND key IN('finance.receivables','finance.receivable_collections','finance.accounting_periods')
   AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=at_time AND(effective_to IS NULL OR effective_to>at_time)
  ORDER BY key,effective_from DESC,version DESC
 )
 SELECT jsonb_build_object('schemaVersion',1,
  'source',jsonb_build_object('id',s.id::text,'version',s.version,'value',s.value),
  'collection',jsonb_build_object('id',c.id::text,'version',c.version,'value',c.value),
  'calendar',jsonb_build_object('id',p.id::text,'version',p.version,'value',p.value))
 FROM effective s CROSS JOIN effective c CROSS JOIN effective p
 WHERE s.key='finance.receivables' AND c.key='finance.receivable_collections' AND p.key='finance.accounting_periods'
  AND s.id=source_uuid AND c.id=collection_uuid AND p.id=calendar_uuid;
$$;

CREATE FUNCTION app_assert_receivable_collection_policy(value jsonb) RETURNS void LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE method jsonb;labels jsonb;
BEGIN
 IF value->>'source' IS DISTINCT FROM 'ACTUAL_RECEIPT_AGAINST_ORIGINAL_CLAIM'
  OR value->>'received_date' IS DISTINCT FROM 'ON_OR_AFTER_ORIGINAL_POSTING' OR value->>'closed_period' IS DISTINCT FROM 'REJECT'
  OR value->>'correction_date' IS DISTINCT FROM 'CURRENT_OPEN_PERIOD' OR COALESCE(value->>'bucket','')!~'^[A-Z][A-Z0-9_]{0,119}$'
  OR jsonb_typeof(value->'destination_account_codes') IS DISTINCT FROM 'array' OR jsonb_typeof(value->'payment_methods') IS DISTINCT FROM 'array'
  OR(value-'source'-'received_date'-'closed_period'-'correction_date'-'bucket'-'destination_account_codes'-'payment_methods')<>'{}'::jsonb
 THEN RAISE EXCEPTION 'receivable collection requires its explicit actual receipt, location, date and correction treatment';END IF;
 IF jsonb_array_length(value->'destination_account_codes')=0 OR jsonb_array_length(value->'payment_methods')=0
  OR jsonb_array_length(value->'destination_account_codes')<>(SELECT count(DISTINCT code) FROM jsonb_array_elements_text(value->'destination_account_codes') code)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(value->'destination_account_codes') code WHERE jsonb_typeof(code)<>'string' OR(code#>>'{}')!~'^[A-Z][A-Z0-9_]*$')
  OR jsonb_array_length(value->'payment_methods')<>(SELECT count(DISTINCT entry.method_value->>'key') FROM jsonb_array_elements(value->'payment_methods') entry(method_value))
 THEN RAISE EXCEPTION 'receivable collection methods and actual location codes must be explicit and unique';END IF;
 FOR method IN SELECT * FROM jsonb_array_elements(value->'payment_methods') LOOP
  labels=method->'labels';
  IF jsonb_typeof(method) IS DISTINCT FROM 'object' OR COALESCE(method->>'key','')!~'^[a-z][a-z0-9_.-]{0,119}$' OR(method-'key'-'labels')<>'{}'::jsonb
   OR jsonb_typeof(labels) IS DISTINCT FROM 'object' OR(labels-'en'-'fr'-'ar')<>'{}'::jsonb
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['en','fr','ar']) locale WHERE jsonb_typeof(labels->locale) IS DISTINCT FROM 'string' OR length(btrim(labels->>locale)) NOT BETWEEN 1 AND 120)
  THEN RAISE EXCEPTION 'actual receivable receipt methods require retained EN FR AR labels';END IF;
 END LOOP;
END $$;

CREATE FUNCTION app_receivable_command_kind(org_uuid uuid,key_uuid uuid) RETURNS text LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 SELECT kind FROM(
  SELECT 'ASSIGN'::text kind FROM receivable_assignment WHERE organization_id=org_uuid AND idempotency_key=key_uuid
  UNION ALL SELECT 'RELEASE' FROM receivable_assignment_release WHERE organization_id=org_uuid AND idempotency_key=key_uuid
  UNION ALL SELECT 'COLLECT' FROM receivable_collection WHERE organization_id=org_uuid AND idempotency_key=key_uuid
  UNION ALL SELECT 'REVERSE' FROM receivable_collection_reversal WHERE organization_id=org_uuid AND idempotency_key=key_uuid
 ) commands LIMIT 1;
$$;
CREATE FUNCTION app_receivable_collection_command_key() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE used integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-intent:'||NEW.idempotency_key::text,0));
 SELECT count(*) INTO used FROM(
  SELECT id FROM receivable_assignment WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key
  UNION ALL SELECT id FROM receivable_assignment_release WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key
  UNION ALL SELECT id FROM receivable_collection WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key
  UNION ALL SELECT id FROM receivable_collection_reversal WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key
 ) commands;
 IF used<>0 THEN RAISE EXCEPTION 'receivable intent cannot identify another immutable operation';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receivable_command_key BEFORE INSERT ON receivable_assignment FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_command_key();
CREATE TRIGGER receivable_command_key BEFORE INSERT ON receivable_assignment_release FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_command_key();
CREATE TRIGGER receivable_command_key BEFORE INSERT ON receivable_collection FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_command_key();
CREATE TRIGGER receivable_command_key BEFORE INSERT ON receivable_collection_reversal FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_command_key();

CREATE FUNCTION app_receivable_original_scope_valid(org_uuid uuid,dimensions jsonb) RETURNS boolean
 LANGUAGE plpgsql STABLE SET search_path TO 'public','pg_temp' AS $$
DECLARE refs jsonb;task_uuid uuid;reservation_uuid uuid;property_uuid uuid;owner_uuid uuid;actual_task operation_task%ROWTYPE;actual_reservation reservation%ROWTYPE;
BEGIN
 refs=COALESCE(NULLIF(dimensions,'null'::jsonb),'{}'::jsonb);
 IF jsonb_typeof(refs)<>'object' THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['property_id','owner_id','reservation_id','task_id','job_id']) key
  WHERE refs?key AND jsonb_typeof(refs->key)<>'string') THEN RETURN false;END IF;
 IF refs->>'task_id' IS NOT NULL AND refs->>'job_id' IS NOT NULL AND(refs->>'task_id')::uuid<>(refs->>'job_id')::uuid THEN RETURN false;END IF;
 task_uuid=COALESCE(refs->>'task_id',refs->>'job_id')::uuid;owner_uuid=(refs->>'owner_id')::uuid;
 IF task_uuid IS NOT NULL THEN
  SELECT * INTO actual_task FROM operation_task WHERE organization_id=org_uuid AND id=task_uuid;
  IF actual_task.id IS NULL OR refs->>'reservation_id' IS NOT NULL AND actual_task.reservation_id IS DISTINCT FROM(refs->>'reservation_id')::uuid THEN RETURN false;END IF;
 END IF;
 reservation_uuid=COALESCE((refs->>'reservation_id')::uuid,actual_task.reservation_id);
 IF reservation_uuid IS NOT NULL THEN
  SELECT * INTO actual_reservation FROM reservation WHERE organization_id=org_uuid AND id=reservation_uuid;
  IF actual_reservation.id IS NULL THEN RETURN false;END IF;
 END IF;
 property_uuid=COALESCE((refs->>'property_id')::uuid,actual_reservation.property_id,actual_task.property_id);
 IF property_uuid IS NOT NULL AND(NOT EXISTS(SELECT 1 FROM property WHERE organization_id=org_uuid AND id=property_uuid)
  OR actual_task.id IS NOT NULL AND actual_task.property_id<>property_uuid
  OR actual_reservation.id IS NOT NULL AND actual_reservation.property_id<>property_uuid) THEN RETURN false;END IF;
 IF owner_uuid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM owner WHERE organization_id=org_uuid AND id=owner_uuid) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;

CREATE FUNCTION app_assert_receivable_collection_value(n receivable_collection) RETURNS void LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE a receivable_assignment%ROWTYPE;p posting%ROWTYPE;original financial_transaction%ROWTYPE;journal financial_transaction%ROWTYPE;
 claim ledger_account%ROWTYPE;destination ledger_account%ROWTYPE;policies jsonb;rules jsonb;dims jsonb;actual_collected numeric;minor integer;ref_name text;
BEGIN
 SELECT * INTO a FROM receivable_assignment WHERE organization_id=n.organization_id AND id=n.assignment_id;
 SELECT * INTO p FROM posting WHERE organization_id=n.organization_id AND id=a.posting_id;
 SELECT * INTO original FROM financial_transaction WHERE organization_id=n.organization_id AND id=p.transaction_id;
 SELECT * INTO claim FROM ledger_account WHERE organization_id=n.organization_id AND id=p.ledger_account_id;
 SELECT * INTO destination FROM ledger_account WHERE organization_id=n.organization_id AND id=n.destination_account_id;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=n.organization_id AND id=n.transaction_id;
 SELECT minor_unit INTO minor FROM currency WHERE code=n.currency;
 IF a.id IS NULL OR p.id IS NULL OR original.id IS NULL OR claim.id IS NULL OR destination.id IS NULL OR journal.id IS NULL
  OR a.currency<>n.currency OR p.currency<>n.currency OR a.amount<n.amount OR p.side<>'DEBIT' OR p.amount<=0
  OR claim.account_type<>'CLAIM_OWNERSHIP' OR claim.normal_side<>'DEBIT' OR claim.archived_at IS NOT NULL
  OR NOT original.sealed OR original.reverses_transaction_id IS NOT NULL OR original.occurred_at>n.received_at OR n.received_at>n.created_at
  OR EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=n.organization_id AND reverses_transaction_id=original.id)
  OR EXISTS(SELECT 1 FROM receivable_assignment_release WHERE organization_id=n.organization_id AND assignment_id=a.id)
  OR minor IS NULL OR minor NOT BETWEEN 0 AND 2 OR n.amount<>trunc(n.amount,minor)
  OR n.source_snapshot IS DISTINCT FROM app_receivable_collection_source(n.organization_id,n.assignment_id,n.destination_account_id)
 THEN RAISE EXCEPTION 'receivable receipt requires its actual live original assigned ownership debit and exact source snapshot';END IF;
 IF destination.id=claim.id OR destination.archived_at IS NOT NULL OR destination.normal_side<>'DEBIT' OR destination.code LIKE 'CASH\_CUSTODY\_%' ESCAPE '\'
  OR destination.account_type NOT IN('ASSET','ASSET_LOCATION','STAFF_WALLET')
  OR destination.account_type='STAFF_WALLET' AND NOT EXISTS(SELECT 1 FROM team_wallet wallet JOIN person ON person.organization_id=wallet.organization_id AND person.id=wallet.person_id
   WHERE wallet.organization_id=n.organization_id AND wallet.ledger_account_id=destination.id AND person.archived_at IS NULL)
 THEN RAISE EXCEPTION 'receivable receipt requires its independently selected active actual money location';END IF;
 policies=app_receivable_collection_policies(n.organization_id,n.source_policy_rule_id,n.collection_policy_rule_id,n.calendar_policy_rule_id,n.created_at);
 IF policies IS NULL OR n.policy_snapshot IS DISTINCT FROM policies
  OR policies#>>'{source,value,source}' IS DISTINCT FROM 'POSTED_OWNERSHIP_CLAIMS'
  OR jsonb_typeof(policies#>'{source,value,account_codes}') IS DISTINCT FROM 'array'
  OR NOT((policies#>'{source,value,account_codes}')?claim.code) OR((policies#>'{source,value}')-'source'-'account_codes')<>'{}'::jsonb
 THEN RAISE EXCEPTION 'receivable receipt requires its exact effective original claim policy';END IF;
 IF jsonb_array_length(policies#>'{source,value,account_codes}')=0
  OR jsonb_array_length(policies#>'{source,value,account_codes}')<>(SELECT count(DISTINCT code) FROM jsonb_array_elements_text(policies#>'{source,value,account_codes}') code)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(policies#>'{source,value,account_codes}') code WHERE jsonb_typeof(code)<>'string' OR(code#>>'{}')!~'^[A-Z][A-Z0-9_]*$')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(policies#>'{source,value,account_codes}') code
   WHERE NOT EXISTS(SELECT 1 FROM ledger_account account WHERE account.organization_id=n.organization_id AND account.code=code.value AND account.account_type='CLAIM_OWNERSHIP' AND account.normal_side='DEBIT'))
 THEN RAISE EXCEPTION 'receivable receipt source policy must retain unique actual ownership accounts';END IF;
 rules=policies#>'{collection,value}';PERFORM app_assert_receivable_collection_policy(rules);
 IF NOT((rules->'destination_account_codes')?destination.code) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rules->'payment_methods') method WHERE method->>'key'=n.method)
 THEN RAISE EXCEPTION 'receivable receipt cannot substitute a configured method or money location';END IF;
 IF(SELECT count(*) FROM posting WHERE organization_id=n.organization_id AND transaction_id=n.transaction_id)<>2
  OR NOT journal.sealed OR journal.reverses_transaction_id IS NOT NULL OR journal.created_by IS DISTINCT FROM n.created_by
  OR journal.reference IS DISTINCT FROM 'RECEIVABLE-COLLECTION:'||n.idempotency_key::text OR journal.idempotency_key IS DISTINCT FROM 'receivable-collection:'||n.idempotency_key::text
  OR journal.description IS DISTINCT FROM n.purpose OR journal.occurred_at IS DISTINCT FROM n.received_at
 THEN RAISE EXCEPTION 'receivable collection requires exactly its complete original attributed receipt journal';END IF;
 IF NOT app_receivable_original_scope_valid(n.organization_id,p.dimensions)
 THEN RAISE EXCEPTION 'receivable original source scope is invalid';END IF;
 FOR ref_name IN SELECT unnest(ARRAY['property_id','owner_id','reservation_id','task_id','job_id']) LOOP
  IF p.dimensions->>ref_name IS NOT NULL THEN PERFORM(p.dimensions->>ref_name)::uuid;END IF;
 END LOOP;
 dims=jsonb_strip_nulls(jsonb_build_object('property_id',p.dimensions->'property_id','owner_id',p.dimensions->'owner_id','reservation_id',p.dimensions->'reservation_id','task_id',p.dimensions->'task_id','job_id',p.dimensions->'job_id'))
  ||jsonb_build_object('source','RECEIVABLE_COLLECTION','receivable_collection_id',n.id::text,'receivable_assignment_id',a.id::text,'original_posting_id',p.id::text,'payment_method',n.method);
 IF NOT EXISTS(SELECT 1 FROM posting WHERE organization_id=n.organization_id AND transaction_id=n.transaction_id AND ledger_account_id=destination.id AND side='DEBIT' AND amount=n.amount AND currency=n.currency AND bucket=rules->>'bucket' AND dimensions=dims)
  OR NOT EXISTS(SELECT 1 FROM posting WHERE organization_id=n.organization_id AND transaction_id=n.transaction_id AND ledger_account_id=claim.id AND side='CREDIT' AND amount=n.amount AND currency=n.currency AND bucket=rules->>'bucket' AND dimensions=dims)
 THEN RAISE EXCEPTION 'receivable receipt must retain exact Money ownership, location and original scope separately';END IF;
 SELECT collected INTO actual_collected FROM app_receivable_collection_movements(n.organization_id,a.id,n.currency);
 IF actual_collected<0 OR actual_collected>a.amount THEN RAISE EXCEPTION 'receivable collections cannot exceed the exact original assigned outstanding amount';END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account account JOIN person ON person.organization_id=account.organization_id AND person.id=account.person_id
  WHERE account.organization_id=n.organization_id AND account.id=n.created_by AND account.status='ACTIVE' AND person.archived_at IS NULL)
 THEN RAISE EXCEPTION 'actual active receipt actor required';END IF;
END $$;

CREATE FUNCTION app_receivable_collection_admission() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE a receivable_assignment%ROWTYPE;original_uuid uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-intent:'||NEW.idempotency_key::text,0));
 SELECT * INTO a FROM receivable_assignment WHERE organization_id=NEW.organization_id AND id=NEW.assignment_id;
 SELECT transaction_id INTO original_uuid FROM posting WHERE organization_id=NEW.organization_id AND id=a.posting_id;
 IF original_uuid IS NULL THEN RAISE EXCEPTION 'actual original assigned receipt source required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':journal-reversal:'||original_uuid::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-source:'||a.posting_id::text,0));
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER receivable_collection_admission BEFORE INSERT ON receivable_collection FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_admission();

CREATE FUNCTION app_receivable_collection_complete() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE c receivable_collection%ROWTYPE;born xid;journal_birth xid;expected jsonb;
BEGIN
 SELECT * INTO c FROM receivable_collection WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT xmin INTO born FROM receivable_collection WHERE organization_id=c.organization_id AND id=c.id;
 SELECT xmin INTO journal_birth FROM financial_transaction WHERE organization_id=c.organization_id AND id=c.transaction_id;
 PERFORM app_assert_receivable_collection_value(c);
 IF born IS DISTINCT FROM journal_birth THEN RAISE EXCEPTION 'receivable receipt and actual original financial journal must be born atomically';END IF;
 expected=jsonb_build_object('collectionId',c.id::text,'assignmentId',c.assignment_id::text,'transactionId',c.transaction_id::text,'amount',jsonb_build_object('amount',c.amount::text,'currency',c.currency));
 IF(SELECT count(*) FROM audit_log WHERE organization_id=c.organization_id AND action='finance.receivables.collected' AND resource_type='receivable' AND resource_id=c.id)<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=c.organization_id AND action='finance.receivables.collected' AND resource_type='receivable' AND resource_id=c.id
   AND actor_id=c.created_by AND reason=c.reason AND after=expected AND xmin=born AND date_trunc('milliseconds',occurred_at)=date_trunc('milliseconds',c.created_at))
 THEN RAISE EXCEPTION 'receivable collection requires its unique exact attributed same-birth audit';END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=c.organization_id AND type='ReceivableCollected' AND idempotency_key='receivable-collection:'||c.id::text||':collected'
  AND payload=expected AND xmin=born AND date_trunc('milliseconds',occurred_at)=date_trunc('milliseconds',c.created_at))
 THEN RAISE EXCEPTION 'receivable collection requires its actual atomic domain event';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER receivable_collection_complete AFTER INSERT ON receivable_collection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_complete();

CREATE FUNCTION app_receivable_collection_release_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE a receivable_assignment%ROWTYPE;collected numeric;original_uuid uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-intent:'||NEW.idempotency_key::text,0));
 SELECT * INTO a FROM receivable_assignment WHERE organization_id=NEW.organization_id AND id=NEW.assignment_id;
 SELECT transaction_id INTO original_uuid FROM posting WHERE organization_id=NEW.organization_id AND id=a.posting_id;
 IF original_uuid IS NULL THEN RAISE EXCEPTION 'actual original assigned receipt release source required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':journal-reversal:'||original_uuid::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-source:'||a.posting_id::text,0));
 SELECT m.collected INTO collected FROM app_receivable_collection_movements(NEW.organization_id,a.id,a.currency) m;
 IF collected<>0 THEN RAISE EXCEPTION 'actual receipt movements must be corrected before releasing their original debtor assignment';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receivable_collection_release_guard BEFORE INSERT ON receivable_assignment_release FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_release_guard();

CREATE FUNCTION app_receivable_collection_reversal_source(org_uuid uuid,collection_uuid uuid) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 SELECT jsonb_build_object('schemaVersion',1,
  'collection',jsonb_build_object('id',c.id::text,'assignmentId',c.assignment_id::text,'sourcePostingId',a.posting_id::text,'transactionId',c.transaction_id::text,
   'destinationAccountId',c.destination_account_id::text,'party',jsonb_build_object('kind',a.party_kind,'id',COALESCE(a.guest_id,a.owner_id,a.supplier_id,a.person_id)::text),
   'amount',jsonb_build_object('amount',c.amount::text,'currency',c.currency),'method',(SELECT entry.method_value FROM jsonb_array_elements(c.policy_snapshot#>'{collection,value,payment_methods}') entry(method_value) WHERE entry.method_value->>'key'=c.method LIMIT 1),
   'receivedAt',to_char(c.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'externalReference',c.external_reference,'purpose',c.purpose,'reason',c.reason,
   'createdBy',c.created_by::text,'createdAt',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reversal',NULL),
  'journal',jsonb_set(app_receivable_original_source(org_uuid,receipt_credit.id),'{transaction,reversedByTransactions}','[]'::jsonb))
 FROM receivable_collection c
 JOIN receivable_assignment a ON a.organization_id=c.organization_id AND a.id=c.assignment_id
 JOIN posting original_claim ON original_claim.organization_id=a.organization_id AND original_claim.id=a.posting_id
 JOIN posting receipt_credit ON receipt_credit.organization_id=c.organization_id AND receipt_credit.transaction_id=c.transaction_id
  AND receipt_credit.ledger_account_id=original_claim.ledger_account_id AND receipt_credit.side='CREDIT' AND receipt_credit.currency=c.currency
 WHERE c.organization_id=org_uuid AND c.id=collection_uuid LIMIT 1;
$$;

CREATE FUNCTION app_receivable_collection_correction_policies(org_uuid uuid,collection_uuid uuid,calendar_uuid uuid,at_time timestamptz) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 WITH effective AS MATERIALIZED(
  SELECT DISTINCT ON(key) * FROM config_rule WHERE organization_id=org_uuid AND scope_type='organization' AND scope_id IS NULL
   AND key IN('finance.receivable_collections','finance.accounting_periods')
   AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=at_time AND(effective_to IS NULL OR effective_to>at_time)
  ORDER BY key,effective_from DESC,version DESC
 )
 SELECT jsonb_build_object('schemaVersion',1,'collection',jsonb_build_object('id',c.id::text,'version',c.version,'value',c.value),
  'calendar',jsonb_build_object('id',p.id::text,'version',p.version,'value',p.value))
 FROM effective c CROSS JOIN effective p WHERE c.key='finance.receivable_collections' AND p.key='finance.accounting_periods' AND c.id=collection_uuid AND p.id=calendar_uuid;
$$;

CREATE FUNCTION app_assert_receivable_collection_reversal(n receivable_collection_reversal) RETURNS void LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE c receivable_collection%ROWTYPE;original financial_transaction%ROWTYPE;opposite financial_transaction%ROWTYPE;policies jsonb;actual_collected numeric;
BEGIN
 SELECT * INTO c FROM receivable_collection WHERE organization_id=n.organization_id AND id=n.collection_id;
 SELECT * INTO original FROM financial_transaction WHERE organization_id=n.organization_id AND id=c.transaction_id;
 SELECT * INTO opposite FROM financial_transaction WHERE organization_id=n.organization_id AND id=n.transaction_id;
 IF NOT EXISTS(SELECT 1 FROM user_account account JOIN person ON person.organization_id=account.organization_id AND person.id=account.person_id
  WHERE account.organization_id=n.organization_id AND account.id=n.created_by AND account.status='ACTIVE' AND person.archived_at IS NULL)
 THEN RAISE EXCEPTION 'actual active receipt correction actor required';END IF;
 IF c.id IS NULL OR original.id IS NULL OR opposite.id IS NULL OR NOT original.sealed OR NOT opposite.sealed
  OR original.reverses_transaction_id IS NOT NULL OR opposite.reverses_transaction_id IS DISTINCT FROM original.id
  OR opposite.created_by IS DISTINCT FROM n.created_by OR opposite.description IS DISTINCT FROM n.reason
  OR opposite.reference IS DISTINCT FROM 'RECEIVABLE-COLLECTION:'||c.idempotency_key::text||':VOID'
  OR opposite.idempotency_key IS DISTINCT FROM 'receivable-collection:'||c.idempotency_key::text||':void'
  OR opposite.occurred_at>n.created_at OR opposite.occurred_at<date_trunc('milliseconds',transaction_timestamp())
  OR n.created_at<c.created_at OR n.source_snapshot IS DISTINCT FROM app_receivable_collection_reversal_source(n.organization_id,c.id)
 THEN RAISE EXCEPTION 'receivable correction must retain its actual complete original receipt and exact current opposite';END IF;
 policies=app_receivable_collection_correction_policies(n.organization_id,n.collection_policy_rule_id,n.calendar_policy_rule_id,n.created_at);
 IF policies IS NULL OR policies IS DISTINCT FROM n.policy_snapshot THEN RAISE EXCEPTION 'receivable correction requires its exact actual current correction and calendar policy';END IF;
 PERFORM app_assert_receivable_collection_policy(policies#>'{collection,value}');
 IF date_trunc('month',opposite.occurred_at AT TIME ZONE(policies#>>'{calendar,value,timezone}'))
  IS DISTINCT FROM date_trunc('month',n.created_at AT TIME ZONE(policies#>>'{calendar,value,timezone}'))
 THEN RAISE EXCEPTION 'receivable correction must retain the actual current configured accounting period';END IF;
 IF EXISTS(SELECT 1 FROM(
   (SELECT ledger_account_id,CASE side WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END side,amount,currency,bucket,dimensions FROM posting WHERE organization_id=n.organization_id AND transaction_id=original.id
    EXCEPT ALL SELECT ledger_account_id,side,amount,currency,bucket,dimensions FROM posting WHERE organization_id=n.organization_id AND transaction_id=opposite.id)
   UNION ALL
   (SELECT ledger_account_id,side,amount,currency,bucket,dimensions FROM posting WHERE organization_id=n.organization_id AND transaction_id=opposite.id
    EXCEPT ALL SELECT ledger_account_id,CASE side WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END,amount,currency,bucket,dimensions FROM posting WHERE organization_id=n.organization_id AND transaction_id=original.id)
  ) differences)
 THEN RAISE EXCEPTION 'receivable correction must conserve every original receipt account, currency, cent and scope';END IF;
 SELECT m.collected INTO actual_collected FROM app_receivable_collection_movements(n.organization_id,c.assignment_id,c.currency) m;
 IF actual_collected<0 THEN RAISE EXCEPTION 'receivable correction cannot manufacture an additional negative collection';END IF;
END $$;

CREATE FUNCTION app_receivable_collection_reversal_admission() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE c receivable_collection%ROWTYPE;a receivable_assignment%ROWTYPE;source_uuid uuid;journal_uuid uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-intent:'||NEW.idempotency_key::text,0));
 SELECT * INTO c FROM receivable_collection WHERE organization_id=NEW.organization_id AND id=NEW.collection_id;
 SELECT * INTO a FROM receivable_assignment WHERE organization_id=NEW.organization_id AND id=c.assignment_id;
 SELECT transaction_id INTO source_uuid FROM posting WHERE organization_id=NEW.organization_id AND id=a.posting_id;
 IF c.id IS NULL OR a.id IS NULL OR source_uuid IS NULL THEN RAISE EXCEPTION 'actual original receipt correction source required';END IF;
 FOR journal_uuid IN SELECT DISTINCT id FROM unnest(ARRAY[source_uuid,c.transaction_id]) id ORDER BY id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':journal-reversal:'||journal_uuid::text,0));
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-source:'||a.posting_id::text,0));
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER receivable_collection_reversal_admission BEFORE INSERT ON receivable_collection_reversal FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_reversal_admission();

CREATE FUNCTION app_receivable_collection_reversal_complete() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE r receivable_collection_reversal%ROWTYPE;c receivable_collection%ROWTYPE;born xid;journal_birth xid;expected jsonb;
BEGIN
 SELECT * INTO r FROM receivable_collection_reversal WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT * INTO c FROM receivable_collection WHERE organization_id=r.organization_id AND id=r.collection_id;
 SELECT xmin INTO born FROM receivable_collection_reversal WHERE organization_id=r.organization_id AND id=r.id;
 SELECT xmin INTO journal_birth FROM financial_transaction WHERE organization_id=r.organization_id AND id=r.transaction_id;
 PERFORM app_assert_receivable_collection_reversal(r);
 IF born IS DISTINCT FROM journal_birth THEN RAISE EXCEPTION 'receivable correction and actual opposite journal must be born atomically';END IF;
 expected=jsonb_build_object('collectionId',c.id::text,'reversalId',r.id::text,'transactionId',c.transaction_id::text,'reversalTransactionId',r.transaction_id::text);
 IF(SELECT count(*) FROM audit_log WHERE organization_id=r.organization_id AND action='finance.receivables.collection_reversed' AND resource_type='receivable' AND resource_id=r.id)<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log WHERE organization_id=r.organization_id AND action='finance.receivables.collection_reversed' AND resource_type='receivable' AND resource_id=r.id
   AND actor_id=r.created_by AND reason=r.reason AND after=expected AND xmin=born AND date_trunc('milliseconds',occurred_at)=date_trunc('milliseconds',r.created_at))
 THEN RAISE EXCEPTION 'receivable correction requires its unique exact attributed same-birth audit';END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=r.organization_id AND type='ReceivableCollectionReversed' AND idempotency_key='receivable-collection:'||r.id::text||':reversed'
  AND payload=expected AND xmin=born AND date_trunc('milliseconds',occurred_at)=date_trunc('milliseconds',r.created_at))
 THEN RAISE EXCEPTION 'receivable correction requires its actual atomic domain event';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER receivable_collection_reversal_complete AFTER INSERT ON receivable_collection_reversal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_reversal_complete();

CREATE FUNCTION app_receivable_collection_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE actor_uuid uuid;intent_reason text;birth text;at_time timestamptz;expected jsonb;
BEGIN
 IF NEW.action='finance.receivables.collected' THEN
  SELECT c.created_by,c.reason,c.xmin::text,c.created_at,jsonb_build_object('collectionId',c.id::text,'assignmentId',c.assignment_id::text,'transactionId',c.transaction_id::text,'amount',jsonb_build_object('amount',c.amount::text,'currency',c.currency))
   INTO actor_uuid,intent_reason,birth,at_time,expected FROM receivable_collection c WHERE c.organization_id=NEW.organization_id AND c.id=NEW.resource_id;
 ELSIF NEW.action='finance.receivables.collection_reversed' THEN
  SELECT r.created_by,r.reason,r.xmin::text,r.created_at,jsonb_build_object('collectionId',c.id::text,'reversalId',r.id::text,'transactionId',c.transaction_id::text,'reversalTransactionId',r.transaction_id::text)
   INTO actor_uuid,intent_reason,birth,at_time,expected FROM receivable_collection_reversal r JOIN receivable_collection c ON c.organization_id=r.organization_id AND c.id=r.collection_id
   WHERE r.organization_id=NEW.organization_id AND r.id=NEW.resource_id;
 ELSE RETURN NEW;END IF;
 IF birth IS NULL OR birth::bigint<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
  OR NEW.resource_type IS DISTINCT FROM 'receivable' OR NEW.actor_id IS DISTINCT FROM actor_uuid OR NEW.reason IS DISTINCT FROM intent_reason OR NEW.after IS DISTINCT FROM expected
  OR date_trunc('milliseconds',NEW.occurred_at) IS DISTINCT FROM date_trunc('milliseconds',at_time)
 THEN RAISE EXCEPTION 'receivable collection audit requires its actual immutable original operation and actor';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receivable_collection_audit_guard BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_audit_guard();

CREATE FUNCTION app_receivable_collection_journal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE original_receipt receivable_collection%ROWTYPE;a receivable_assignment%ROWTYPE;collected numeric;links integer;
BEGIN
 IF NEW.reference LIKE 'RECEIVABLE-COLLECTION:%'
  OR EXISTS(SELECT 1 FROM posting WHERE organization_id=NEW.organization_id AND transaction_id=NEW.id AND dimensions?'receivable_collection_id')
 THEN
  SELECT(SELECT count(*) FROM receivable_collection WHERE organization_id=NEW.organization_id AND transaction_id=NEW.id)
   +(SELECT count(*) FROM receivable_collection_reversal WHERE organization_id=NEW.organization_id AND transaction_id=NEW.id) INTO links;
  IF links<>1 THEN RAISE EXCEPTION 'actual receipt journal requires its unique immutable receivable operation';END IF;
 END IF;
 IF NEW.reverses_transaction_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO original_receipt FROM receivable_collection WHERE organization_id=NEW.organization_id AND transaction_id=NEW.reverses_transaction_id;
 IF original_receipt.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM receivable_collection_reversal WHERE organization_id=NEW.organization_id AND collection_id=original_receipt.id AND transaction_id=NEW.id)
 THEN RAISE EXCEPTION 'original receivable receipt requires its complete typed attributed correction';END IF;
 FOR a IN SELECT assignment.* FROM receivable_assignment assignment JOIN posting p ON p.organization_id=assignment.organization_id AND p.id=assignment.posting_id
  WHERE assignment.organization_id=NEW.organization_id AND p.transaction_id=NEW.reverses_transaction_id LOOP
  SELECT movements.collected INTO collected FROM app_receivable_collection_movements(NEW.organization_id,a.id,a.currency) movements;
  IF collected<>0 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='receivable_source_has_collections',MESSAGE='actual receivable receipts must be corrected before reversing their original debt source';END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER receivable_collection_journal_guard AFTER INSERT ON financial_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_receivable_collection_journal_guard();

COMMIT;
