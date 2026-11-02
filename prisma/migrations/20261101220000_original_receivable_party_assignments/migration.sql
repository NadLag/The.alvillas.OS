BEGIN;
-- CreateTable
CREATE TABLE "receivable_assignment" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "posting_id" UUID NOT NULL,
    "party_kind" VARCHAR(16) NOT NULL,
    "guest_id" UUID,
    "owner_id" UUID,
    "supplier_id" UUID,
    "person_id" UUID,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "due_on" DATE,
    "purpose" VARCHAR(1000) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "source_policy_rule_id" UUID NOT NULL,
    "assignment_policy_rule_id" UUID NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receivable_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_assignment_release" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receivable_assignment_release_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receivable_assignment_source_idx" ON "receivable_assignment"("organization_id", "posting_id", "id");

-- CreateIndex
CREATE INDEX "receivable_assignment_due_idx" ON "receivable_assignment"("organization_id", "currency", "due_on", "id");

-- CreateIndex
CREATE INDEX "receivable_assignment_guest_idx" ON "receivable_assignment"("organization_id", "guest_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "receivable_assignment_owner_idx" ON "receivable_assignment"("organization_id", "owner_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "receivable_assignment_supplier_idx" ON "receivable_assignment"("organization_id", "supplier_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "receivable_assignment_person_idx" ON "receivable_assignment"("organization_id", "person_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_assignment_org_id" ON "receivable_assignment"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_assignment_org_key" ON "receivable_assignment"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "receivable_release_created_idx" ON "receivable_assignment_release"("organization_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_release_org_id" ON "receivable_assignment_release"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_release_original_unique" ON "receivable_assignment_release"("organization_id", "assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_release_org_key" ON "receivable_assignment_release"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_organization_id_posting_id_fkey" FOREIGN KEY ("organization_id", "posting_id") REFERENCES "posting"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_organization_id_guest_id_fkey" FOREIGN KEY ("organization_id", "guest_id") REFERENCES "guest"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_organization_id_owner_id_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "supplier"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_organization_id_source_policy_rule_i_fkey" FOREIGN KEY ("organization_id", "source_policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_organization_id_assignment_policy_ru_fkey" FOREIGN KEY ("organization_id", "assignment_policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment" ADD CONSTRAINT "receivable_assignment_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment_release" ADD CONSTRAINT "receivable_assignment_release_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment_release" ADD CONSTRAINT "receivable_assignment_release_organization_id_assignment_i_fkey" FOREIGN KEY ("organization_id", "assignment_id") REFERENCES "receivable_assignment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receivable_assignment_release" ADD CONSTRAINT "receivable_assignment_release_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE receivable_assignment ADD CONSTRAINT receivable_assignment_intent CHECK((
 amount>0 AND amount<>'NaN'::numeric AND party_kind IN('GUEST','OWNER','SUPPLIER','PERSON')
 AND num_nonnulls(guest_id,owner_id,supplier_id,person_id)=1
 AND ((party_kind='GUEST' AND guest_id IS NOT NULL) OR(party_kind='OWNER' AND owner_id IS NOT NULL)
   OR(party_kind='SUPPLIER' AND supplier_id IS NOT NULL) OR(party_kind='PERSON' AND person_id IS NOT NULL))
 AND length(btrim(purpose)) BETWEEN 3 AND 1000 AND length(btrim(reason)) BETWEEN 6 AND 500
 AND request_fingerprint~'^[a-f0-9]{64}$' AND review_fingerprint~'^[a-f0-9]{64}$'
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND authorization_cap->>'schemaVersion'='1' AND authorization_cap->>'organizationId'=organization_id::text
 AND authorization_cap->>'userAccountId'=created_by::text) IS TRUE);
ALTER TABLE receivable_assignment_release ADD CONSTRAINT receivable_release_intent CHECK((
 length(btrim(reason)) BETWEEN 6 AND 500 AND request_fingerprint~'^[a-f0-9]{64}$' AND review_fingerprint~'^[a-f0-9]{64}$') IS TRUE);

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['receivable_assignment','receivable_assignment_release'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid)',tab||'_tenant_isolation',tab);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation()',tab||'_immutable',tab);
 END LOOP;
END $$;

CREATE FUNCTION app_receivable_original_source(org_uuid uuid,posting_uuid uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 WITH selected_posting AS MATERIALIZED(SELECT * FROM posting WHERE organization_id=org_uuid AND id=posting_uuid)
 SELECT jsonb_build_object('schemaVersion',1,'posting',jsonb_build_object('id',p.id::text,'organizationId',p.organization_id::text,'transactionId',p.transaction_id::text,
  'ledgerAccountId',p.ledger_account_id::text,'side',p.side,'amount',p.amount::text,'currency',p.currency,'bucket',p.bucket,'dimensions',p.dimensions),
  'transaction',jsonb_build_object('id',t.id::text,'organizationId',t.organization_id::text,'occurredAt',to_char(t.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'sealed',t.sealed,'reversesTransactionId',t.reverses_transaction_id::text,
   'reversedByTransactions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id::text) ORDER BY r.id) FROM financial_transaction r WHERE r.organization_id=t.organization_id AND r.reverses_transaction_id=t.id),'[]'::jsonb),
   'postings',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id::text,'ledgerAccountId',q.ledger_account_id::text,'side',q.side,'amount',q.amount::text,'currency',q.currency,'bucket',q.bucket,'dimensions',q.dimensions) ORDER BY q.id)
    FROM posting q WHERE q.organization_id=t.organization_id AND q.transaction_id=t.id),'[]'::jsonb)),
  'account',jsonb_build_object('id',k.id::text,'organizationId',k.organization_id::text,'code',k.code,'accountType',k.account_type,'normalSide',k.normal_side))
 FROM selected_posting p JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
 JOIN ledger_account k ON k.organization_id=p.organization_id AND k.id=p.ledger_account_id
 WHERE p.organization_id=org_uuid AND p.id=posting_uuid;
$$;

CREATE FUNCTION app_receivable_assignment_policies(org_uuid uuid,source_uuid uuid,assignment_uuid uuid,at_time timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 WITH source AS(SELECT * FROM config_rule WHERE organization_id=org_uuid AND key='finance.receivables' AND scope_type='organization' AND scope_id IS NULL
  AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=at_time AND(effective_to IS NULL OR effective_to>at_time) ORDER BY effective_from DESC,version DESC LIMIT 1),
 assignment AS(SELECT * FROM config_rule WHERE organization_id=org_uuid AND key='finance.receivable_assignments' AND scope_type='organization' AND scope_id IS NULL
  AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED') AND effective_from<=at_time AND(effective_to IS NULL OR effective_to>at_time) ORDER BY effective_from DESC,version DESC LIMIT 1)
 SELECT jsonb_build_object('schemaVersion',1,'source',jsonb_build_object('id',s.id::text,'version',s.version,'value',s.value),
  'assignment',jsonb_build_object('id',a.id::text,'version',a.version,'value',a.value)) FROM source s CROSS JOIN assignment a
 WHERE s.id=source_uuid AND a.id=assignment_uuid;
$$;

CREATE FUNCTION app_assert_receivable_assignment_value(n receivable_assignment) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE p posting%ROWTYPE; t financial_transaction%ROWTYPE; k ledger_account%ROWTYPE; policies jsonb; assigned numeric;
BEGIN
 SELECT * INTO p FROM posting WHERE organization_id=n.organization_id AND id=n.posting_id;
 SELECT * INTO t FROM financial_transaction WHERE organization_id=n.organization_id AND id=p.transaction_id;
 SELECT * INTO k FROM ledger_account WHERE organization_id=n.organization_id AND id=p.ledger_account_id;
 IF p.id IS NULL OR t.id IS NULL OR k.id IS NULL OR p.side<>'DEBIT' OR p.currency<>n.currency OR p.amount<=0
  OR k.account_type<>'CLAIM_OWNERSHIP' OR k.normal_side<>'DEBIT' OR NOT t.sealed OR t.reverses_transaction_id IS NOT NULL
  OR t.occurred_at>n.created_at OR EXISTS(SELECT 1 FROM financial_transaction WHERE organization_id=n.organization_id AND reverses_transaction_id=t.id)
  OR n.source_snapshot IS DISTINCT FROM app_receivable_original_source(n.organization_id,n.posting_id)
 THEN RAISE EXCEPTION 'receivable assignment requires its actual original posted ownership debit and complete journal';END IF;
 policies=app_receivable_assignment_policies(n.organization_id,n.source_policy_rule_id,n.assignment_policy_rule_id,n.created_at);
 IF policies IS NULL OR n.policy_snapshot IS DISTINCT FROM policies
  OR policies#>>'{source,value,source}' IS DISTINCT FROM 'POSTED_OWNERSHIP_CLAIMS'
  OR jsonb_typeof(policies#>'{source,value,account_codes}') IS DISTINCT FROM 'array'
  OR NOT((policies#>'{source,value,account_codes}')?k.code)
  OR((policies#>'{source,value}')-'source'-'account_codes')<>'{}'::jsonb
  OR policies#>>'{assignment,value,source}' IS DISTINCT FROM 'ORIGINAL_POSTED_DEBIT'
  OR policies#>>'{assignment,value,due_date}' IS DISTINCT FROM 'EXPLICIT_OR_UNSCHEDULED'
  OR jsonb_typeof(policies#>'{assignment,value,party_types}') IS DISTINCT FROM 'array'
  OR NOT((policies#>'{assignment,value,party_types}')?n.party_kind)
  OR((policies#>'{assignment,value}')-'source'-'party_types'-'due_date')<>'{}'::jsonb
 THEN RAISE EXCEPTION 'receivable assignment requires its exact effective source and explicit party policy';END IF;
 IF jsonb_array_length(policies#>'{source,value,account_codes}')=0
  OR jsonb_array_length(policies#>'{source,value,account_codes}')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(policies#>'{source,value,account_codes}'))
  OR jsonb_array_length(policies#>'{assignment,value,party_types}')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(policies#>'{assignment,value,party_types}'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(policies#>'{source,value,account_codes}') WHERE value!~'^[A-Z][A-Z0-9_]*$')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(policies#>'{assignment,value,party_types}') WHERE value NOT IN('GUEST','OWNER','SUPPLIER','PERSON'))
 THEN RAISE EXCEPTION 'receivable policy requires unique explicit ownership accounts and supported party identities';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(policies#>'{source,value,account_codes}') code
  WHERE NOT EXISTS(SELECT 1 FROM ledger_account account WHERE account.organization_id=n.organization_id AND account.code=code.value AND account.account_type='CLAIM_OWNERSHIP' AND account.normal_side='DEBIT'))
 THEN RAISE EXCEPTION 'receivable ownership policy cannot substitute a money location';END IF;
 SELECT COALESCE(sum(a.amount),0) INTO assigned FROM receivable_assignment a WHERE a.organization_id=n.organization_id AND a.posting_id=n.posting_id AND a.id<>n.id
  AND NOT EXISTS(SELECT 1 FROM receivable_assignment_release r WHERE r.organization_id=a.organization_id AND r.assignment_id=a.id);
 IF NOT EXISTS(SELECT 1 FROM receivable_assignment_release WHERE organization_id=n.organization_id AND assignment_id=n.id) THEN assigned=assigned+n.amount;END IF;
 IF assigned>p.amount THEN RAISE EXCEPTION 'receivable assignment cannot exceed exact original unassigned posted amount';END IF;
END $$;

CREATE FUNCTION app_receivable_assignment_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE journal_uuid uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-intent:'||NEW.idempotency_key::text,0));
 IF EXISTS(SELECT 1 FROM receivable_assignment_release WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'receivable intent cannot be reinterpreted as a different operation';END IF;
 SELECT transaction_id INTO journal_uuid FROM posting WHERE organization_id=NEW.organization_id AND id=NEW.posting_id;
 IF journal_uuid IS NULL THEN RAISE EXCEPTION 'receivable assignment requires its actual tenant source';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':journal-reversal:'||journal_uuid::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-source:'||NEW.posting_id::text,0));
 NEW.created_at=clock_timestamp();PERFORM app_assert_receivable_assignment_value(NEW);RETURN NEW;
END $$;
CREATE TRIGGER receivable_assignment_admission BEFORE INSERT ON receivable_assignment FOR EACH ROW EXECUTE FUNCTION app_receivable_assignment_admission();

CREATE FUNCTION app_receivable_release_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE a receivable_assignment%ROWTYPE; journal_uuid uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-intent:'||NEW.idempotency_key::text,0));
 IF EXISTS(SELECT 1 FROM receivable_assignment WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'receivable intent cannot be reinterpreted as a different operation';END IF;
 SELECT * INTO a FROM receivable_assignment WHERE organization_id=NEW.organization_id AND id=NEW.assignment_id;
 SELECT transaction_id INTO journal_uuid FROM posting WHERE organization_id=NEW.organization_id AND id=a.posting_id;
 IF a.id IS NULL OR journal_uuid IS NULL THEN RAISE EXCEPTION 'receivable release requires its actual original tenant assignment';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':journal-reversal:'||journal_uuid::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':receivable-source:'||a.posting_id::text,0));
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER receivable_release_admission BEFORE INSERT ON receivable_assignment_release FOR EACH ROW EXECUTE FUNCTION app_receivable_release_admission();

CREATE FUNCTION app_receivable_assignment_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE a receivable_assignment%ROWTYPE; r receivable_assignment_release%ROWTYPE; born xid; expected jsonb; event_type text; event_key text; actor_uuid uuid; intent_reason text; at_time timestamptz; event_payload jsonb;
BEGIN
 IF TG_TABLE_NAME='receivable_assignment' THEN
  SELECT * INTO a FROM receivable_assignment WHERE organization_id=NEW.organization_id AND id=NEW.id;
  SELECT xmin INTO born FROM receivable_assignment WHERE organization_id=a.organization_id AND id=a.id;
  PERFORM app_assert_receivable_assignment_value(a);
  expected=jsonb_build_object('assignmentId',a.id::text,'postingId',a.posting_id::text,'partyKind',a.party_kind,'partyId',COALESCE(a.guest_id,a.owner_id,a.supplier_id,a.person_id)::text);
  event_type='ReceivableAssigned';event_key='receivable-assignment:'||a.id::text||':assigned';event_payload=jsonb_build_object('assignmentId',a.id::text);
  actor_uuid=a.created_by;intent_reason=a.reason;at_time=a.created_at;
 ELSE
  SELECT * INTO r FROM receivable_assignment_release WHERE organization_id=NEW.organization_id AND id=NEW.id;
  SELECT xmin INTO born FROM receivable_assignment_release WHERE organization_id=r.organization_id AND id=r.id;
  SELECT * INTO a FROM receivable_assignment WHERE organization_id=r.organization_id AND id=r.assignment_id;
  IF a.id IS NULL OR r.created_at<a.created_at THEN RAISE EXCEPTION 'receivable release cannot replace original assignment history';END IF;
  expected=jsonb_build_object('assignmentId',a.id::text,'releaseId',r.id::text);
  event_type='ReceivableAssignmentReleased';event_key='receivable-assignment:'||r.id::text||':released';event_payload=expected;
  actor_uuid=r.created_by;intent_reason=r.reason;at_time=r.created_at;
 END IF;
 IF(SELECT count(*) FROM audit_log audit WHERE audit.organization_id=NEW.organization_id AND audit.resource_type='receivable' AND audit.resource_id=NEW.id
  AND audit.action=CASE WHEN TG_TABLE_NAME='receivable_assignment' THEN 'finance.receivables.assigned' ELSE 'finance.receivables.assignment_released' END
  AND audit.actor_id=actor_uuid AND audit.reason=intent_reason AND audit.after=expected AND audit.xmin=born
  AND date_trunc('milliseconds',audit.occurred_at)=date_trunc('milliseconds',at_time))<>1
 THEN RAISE EXCEPTION 'receivable history requires its exact attributed same-birth audit';END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event event WHERE event.organization_id=NEW.organization_id AND event.type=event_type AND event.idempotency_key=event_key
  AND event.payload=event_payload AND event.xmin=born AND date_trunc('milliseconds',event.occurred_at)=date_trunc('milliseconds',at_time))
 THEN RAISE EXCEPTION 'receivable history requires its actual atomic domain event';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER receivable_assignment_complete AFTER INSERT ON receivable_assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_receivable_assignment_complete();
CREATE CONSTRAINT TRIGGER receivable_release_complete AFTER INSERT ON receivable_assignment_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_receivable_assignment_complete();

CREATE FUNCTION app_receivable_audit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE actor_uuid uuid; intent_reason text; birth text; expected jsonb; at_time timestamptz;
BEGIN
 IF NEW.action='finance.receivables.assigned' THEN
  SELECT a.created_by,a.reason,a.xmin::text,a.created_at,jsonb_build_object('assignmentId',a.id::text,'postingId',a.posting_id::text,'partyKind',a.party_kind,'partyId',COALESCE(a.guest_id,a.owner_id,a.supplier_id,a.person_id)::text)
   INTO actor_uuid,intent_reason,birth,at_time,expected FROM receivable_assignment a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.resource_id;
 ELSIF NEW.action='finance.receivables.assignment_released' THEN
  SELECT r.created_by,r.reason,r.xmin::text,r.created_at,jsonb_build_object('assignmentId',r.assignment_id::text,'releaseId',r.id::text)
   INTO actor_uuid,intent_reason,birth,at_time,expected FROM receivable_assignment_release r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.resource_id;
 ELSE RETURN NEW;END IF;
 IF birth IS NULL OR birth::bigint<>mod(pg_current_xact_id()::text::numeric,4294967296)::bigint
  OR NEW.resource_type IS DISTINCT FROM 'receivable' OR NEW.actor_id IS DISTINCT FROM actor_uuid OR NEW.reason IS DISTINCT FROM intent_reason
  OR NEW.after IS DISTINCT FROM expected OR date_trunc('milliseconds',NEW.occurred_at) IS DISTINCT FROM date_trunc('milliseconds',at_time)
 THEN RAISE EXCEPTION 'receivable audit requires its actual immutable original assignment intent';END IF;RETURN NEW;
END $$;
CREATE TRIGGER receivable_audit_guard BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION app_receivable_audit_guard();

COMMIT;
