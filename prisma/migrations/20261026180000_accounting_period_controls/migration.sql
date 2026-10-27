BEGIN;

-- CreateTable
CREATE TABLE "accounting_period" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "timezone" VARCHAR(120) NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "policy_rule_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_period_event" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "previous_event_id" UUID,
    "reopens_until" TIMESTAMPTZ(6),
    "reopen_seconds" INTEGER,
    "policy_rule_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_period_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_period_organization_id_starts_at_ends_at_idx" ON "accounting_period"("organization_id", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_organization_id_id_key" ON "accounting_period"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_organization_id_month_key" ON "accounting_period"("organization_id", "month");

-- CreateIndex
CREATE INDEX "accounting_period_event_organization_id_period_id_created_a_idx" ON "accounting_period_event"("organization_id", "period_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_event_organization_id_id_key" ON "accounting_period_event"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_event_organization_id_idempotency_key_key" ON "accounting_period_event"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_event_organization_id_period_id_version_key" ON "accounting_period_event"("organization_id", "period_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_period_event_organization_id_previous_event_id_key" ON "accounting_period_event"("organization_id", "previous_event_id");

-- AddForeignKey
ALTER TABLE "accounting_period" ADD CONSTRAINT "accounting_period_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period" ADD CONSTRAINT "accounting_period_organization_id_policy_rule_id_fkey" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period" ADD CONSTRAINT "accounting_period_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_event" ADD CONSTRAINT "accounting_period_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_event" ADD CONSTRAINT "accounting_period_event_organization_id_period_id_fkey" FOREIGN KEY ("organization_id", "period_id") REFERENCES "accounting_period"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_event" ADD CONSTRAINT "accounting_period_event_organization_id_previous_event_id_fkey" FOREIGN KEY ("organization_id", "previous_event_id") REFERENCES "accounting_period_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_event" ADD CONSTRAINT "accounting_period_event_organization_id_policy_rule_id_fkey" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounting_period_event" ADD CONSTRAINT "accounting_period_event_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE accounting_period ADD CONSTRAINT accounting_period_month_check CHECK (extract(day FROM month)=1 AND starts_at<ends_at);
ALTER TABLE accounting_period_event ADD CONSTRAINT accounting_period_event_kind_check CHECK (kind IN ('CLOSE','REOPEN'));
ALTER TABLE accounting_period_event ADD CONSTRAINT accounting_period_event_reason_check CHECK (length(btrim(reason)) BETWEEN 3 AND 1000);
ALTER TABLE accounting_period_event ADD CONSTRAINT accounting_period_event_version_check CHECK (version>0);

ALTER TABLE accounting_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_period FORCE ROW LEVEL SECURITY;
CREATE POLICY accounting_period_tenant ON accounting_period
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE accounting_period_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_period_event FORCE ROW LEVEL SECURITY;
CREATE POLICY accounting_period_event_tenant ON accounting_period_event
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER accounting_period_immutable BEFORE UPDATE OR DELETE ON accounting_period
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER accounting_period_event_immutable BEFORE UPDATE OR DELETE ON accounting_period_event
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_accounting_period_policy(organization_uuid uuid,policy_uuid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE rule config_rule%ROWTYPE;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=organization_uuid AND key='finance.accounting_periods'
  AND scope_type='organization' AND scope_id IS NULL AND archived_at IS NULL AND lifecycle IN ('ACTIVE','RETIRED')
  AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp())
 ORDER BY effective_from DESC,version DESC,created_at DESC LIMIT 1;
 IF rule.id IS DISTINCT FROM policy_uuid THEN RAISE EXCEPTION 'current accounting period policy is required'; END IF;
 IF jsonb_typeof(rule.value->'timezone') IS DISTINCT FROM 'string'
  OR jsonb_typeof(rule.value->'allow_early_close') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(rule.value->'max_reopen_seconds') IS DISTINCT FROM 'number'
 THEN RAISE EXCEPTION 'accounting period policy is invalid'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=rule.value->>'timezone')
  OR (rule.value->>'max_reopen_seconds')::numeric NOT BETWEEN 1 AND 2147483647
  OR mod((rule.value->>'max_reopen_seconds')::numeric,1)<>0
 THEN RAISE EXCEPTION 'accounting period policy is invalid'; END IF;
 RETURN rule.value;
END $$;

CREATE FUNCTION app_accounting_period_snapshot(organization_uuid uuid,period_start timestamptz,period_end timestamptz)
RETURNS jsonb LANGUAGE sql AS $$
 WITH headers AS (
  SELECT id,reference,occurred_at,description,reverses_transaction_id,idempotency_key,created_by,sealed
  FROM financial_transaction WHERE organization_id=organization_uuid AND occurred_at>=period_start AND occurred_at<period_end
 ), lines AS (
  SELECT p.id,p.transaction_id,p.ledger_account_id,p.side,p.amount,p.currency,p.bucket,p.dimensions
  FROM posting p JOIN headers h ON h.id=p.transaction_id WHERE p.organization_id=organization_uuid
 ), totals AS (
  SELECT currency,COALESCE(sum(amount) FILTER(WHERE side='DEBIT'),0) AS debit,
   COALESCE(sum(amount) FILTER(WHERE side='CREDIT'),0) AS credit FROM lines GROUP BY currency
 )
 SELECT jsonb_build_object('version',1,'transactions',(SELECT count(*) FROM headers),'postings',(SELECT count(*) FROM lines),
  'unsealed',(SELECT count(*) FROM headers WHERE NOT sealed),
  'financialHash',encode(digest(
   COALESCE((SELECT string_agg(jsonb_build_array(id,reference,extract(epoch FROM occurred_at)::text,description,reverses_transaction_id,idempotency_key,created_by)::text,E'\n' ORDER BY id) FROM headers),'')
   ||E'\n---\n'||COALESCE((SELECT string_agg(jsonb_build_array(id,transaction_id,ledger_account_id,side,amount::text,currency,bucket,dimensions)::text,E'\n' ORDER BY id) FROM lines),''),'sha256'),'hex'),
  'currencies',COALESCE((SELECT jsonb_agg(jsonb_build_object('currency',currency,'debit',debit::text,'credit',credit::text) ORDER BY currency) FROM totals),'[]'::jsonb));
$$;

CREATE FUNCTION app_accounting_period_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':accounting-period',0));
 policy:=app_accounting_period_policy(NEW.organization_id,NEW.policy_rule_id);
 IF NEW.timezone IS DISTINCT FROM policy->>'timezone'
  OR NEW.starts_at IS DISTINCT FROM (NEW.month::timestamp AT TIME ZONE NEW.timezone)
  OR NEW.ends_at IS DISTINCT FROM ((NEW.month::timestamp+interval '1 month') AT TIME ZONE NEW.timezone)
 THEN RAISE EXCEPTION 'accounting period calendar does not match its policy'; END IF;
 IF EXISTS(SELECT 1 FROM accounting_period p WHERE p.organization_id=NEW.organization_id AND p.starts_at<NEW.ends_at AND p.ends_at>NEW.starts_at)
 THEN RAISE EXCEPTION 'accounting period overlaps an existing calendar'; END IF;
 NEW.created_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER accounting_period_root_guard BEFORE INSERT ON accounting_period
 FOR EACH ROW EXECUTE FUNCTION app_accounting_period_root_guard();

CREATE FUNCTION app_accounting_period_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE period accounting_period%ROWTYPE; previous accounting_period_event%ROWTYPE; policy jsonb; point timestamptz; facts jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':accounting-period',0));
 point:=clock_timestamp();
 SELECT * INTO period FROM accounting_period WHERE organization_id=NEW.organization_id AND id=NEW.period_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting period is unavailable'; END IF;
 SELECT * INTO previous FROM accounting_period_event WHERE organization_id=NEW.organization_id AND period_id=period.id ORDER BY version DESC LIMIT 1;
 IF NEW.previous_event_id IS DISTINCT FROM previous.id OR NEW.version<>COALESCE(previous.version,0)+1
 THEN RAISE EXCEPTION 'accounting period version has changed'; END IF;
 policy:=app_accounting_period_policy(NEW.organization_id,NEW.policy_rule_id);
 IF NEW.kind='CLOSE' THEN
  IF previous.kind='CLOSE' OR NEW.reopens_until IS NOT NULL OR NEW.reopen_seconds IS NOT NULL THEN RAISE EXCEPTION 'accounting period is already closed'; END IF;
  IF period.ends_at>point AND NOT (policy->>'allow_early_close')::boolean THEN RAISE EXCEPTION 'early accounting period close is not configured'; END IF;
 ELSIF NEW.kind='REOPEN' THEN
  IF previous.id IS NULL OR (previous.kind='REOPEN' AND previous.reopens_until>point)
  THEN RAISE EXCEPTION 'accounting period must be closed before reopening'; END IF;
  IF NEW.reopen_seconds IS NULL OR NEW.reopen_seconds<=0
   OR NEW.reopen_seconds>(policy->>'max_reopen_seconds')::int
  THEN RAISE EXCEPTION 'accounting period reopening window is invalid'; END IF;
  NEW.reopens_until:=point+make_interval(secs=>NEW.reopen_seconds);
 ELSE RAISE EXCEPTION 'accounting period operation is invalid'; END IF;
 facts:=app_accounting_period_snapshot(NEW.organization_id,period.starts_at,period.ends_at);
 IF NEW.snapshot IS DISTINCT FROM facts OR (facts->>'unsealed')::bigint<>0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(facts->'currencies') c WHERE (c->>'debit')::numeric<>(c->>'credit')::numeric)
 THEN RAISE EXCEPTION 'accounting period snapshot must match the complete balanced journal'; END IF;
 NEW.created_at:=point;
 RETURN NEW;
END $$;
CREATE TRIGGER accounting_period_event_guard BEFORE INSERT ON accounting_period_event
 FOR EACH ROW EXECUTE FUNCTION app_accounting_period_event_guard();

CREATE FUNCTION app_accounting_period_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='accounting_period' THEN
  IF NOT EXISTS(SELECT 1 FROM accounting_period_event e WHERE e.organization_id=NEW.organization_id AND e.period_id=NEW.id
   AND e.version=1 AND e.kind='CLOSE' AND e.created_by=NEW.created_by AND e.policy_rule_id=NEW.policy_rule_id)
  THEN RAISE EXCEPTION 'accounting period must close atomically'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
  AND a.resource_type='accounting_period' AND a.resource_id=NEW.period_id AND a.reason=NEW.reason
  AND a.action=CASE NEW.kind WHEN 'CLOSE' THEN 'finance.period.closed' ELSE 'finance.period.reopened' END
  AND a.after->>'eventId'=NEW.id::text AND a.after->>'version'=NEW.version::text AND a.after->>'kind'=NEW.kind
  AND a.after->>'policyRuleId'=NEW.policy_rule_id::text AND a.after->'snapshot'=NEW.snapshot
  AND (a.after->>'durationSeconds')::int IS NOT DISTINCT FROM NEW.reopen_seconds
  AND (a.after->>'reopensUntil')::timestamptz IS NOT DISTINCT FROM NEW.reopens_until)
 THEN RAISE EXCEPTION 'accounting period audit must commit atomically'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER accounting_period_atomic_close AFTER INSERT ON accounting_period
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_accounting_period_audit_guard();
CREATE CONSTRAINT TRIGGER accounting_period_atomic_audit AFTER INSERT ON accounting_period_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_accounting_period_audit_guard();

CREATE FUNCTION app_financial_period_is_open(organization_uuid uuid,occurred timestamptz) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE period accounting_period%ROWTYPE; event accounting_period_event%ROWTYPE;
BEGIN
 -- Writers share the organization lock; closing/reopening acquires it exclusively.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(organization_uuid::text||':accounting-period',0));
 SELECT * INTO period FROM accounting_period WHERE organization_id=organization_uuid AND starts_at<=occurred AND ends_at>occurred;
 IF NOT FOUND THEN RETURN true; END IF;
 SELECT * INTO event FROM accounting_period_event WHERE organization_id=organization_uuid AND period_id=period.id ORDER BY version DESC LIMIT 1;
 RETURN COALESCE(event.kind='REOPEN' AND event.reopens_until>clock_timestamp(),false);
END $$;
CREATE FUNCTION app_financial_period_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT app_financial_period_is_open(NEW.organization_id,NEW.occurred_at)
 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='financial_period_open',MESSAGE='financial posting date is in a closed accounting period'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_transaction_period_guard BEFORE INSERT ON financial_transaction
 FOR EACH ROW EXECUTE FUNCTION app_financial_period_insert_guard();

COMMIT;
