BEGIN;

-- CreateTable
CREATE TABLE "variance_workflow_event" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "variance_id" UUID,
    "bank_entry_id" UUID,
    "claim_id" UUID,
    "stocktake_id" UUID,
    "source_audit_id" UUID,
    "source_fingerprint" CHAR(64) NOT NULL,
    "version" BIGINT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "assigned_to" UUID,
    "reason" TEXT NOT NULL,
    "action" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "actor_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "intent" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variance_workflow_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "variance_workflow_event_history_idx" ON "variance_workflow_event"("organization_id", "provider", "source_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "variance_workflow_event_org_id_unique" ON "variance_workflow_event"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "variance_workflow_event_source_version_unique" ON "variance_workflow_event"("organization_id", "provider", "source_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "variance_workflow_event_actor_nonce_unique" ON "variance_workflow_event"("organization_id", "actor_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_org_id_unique" ON "audit_log"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "variance_org_id_unique" ON "variance"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "variance_workflow_event" ADD CONSTRAINT "variance_workflow_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "variance_workflow_event" ADD CONSTRAINT "variance_workflow_event_organization_id_variance_id_fkey" FOREIGN KEY ("organization_id", "variance_id") REFERENCES "variance"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "variance_workflow_event" ADD CONSTRAINT "variance_workflow_event_organization_id_bank_entry_id_fkey" FOREIGN KEY ("organization_id", "bank_entry_id") REFERENCES "bank_reconciliation_entry"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "variance_workflow_event" ADD CONSTRAINT "variance_workflow_event_organization_id_claim_id_fkey" FOREIGN KEY ("organization_id", "claim_id") REFERENCES "employee_compensation_claim"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "variance_workflow_event" ADD CONSTRAINT "variance_workflow_event_organization_id_stocktake_id_fkey" FOREIGN KEY ("organization_id", "stocktake_id") REFERENCES "inventory_stocktake"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "variance_workflow_event" ADD CONSTRAINT "variance_workflow_event_organization_id_source_audit_id_fkey" FOREIGN KEY ("organization_id", "source_audit_id") REFERENCES "audit_log"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "variance_workflow_event" ADD CONSTRAINT "variance_workflow_event_organization_id_actor_id_fkey" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "variance_workflow_event" ADD CONSTRAINT "variance_workflow_event_organization_id_assigned_to_fkey" FOREIGN KEY ("organization_id", "assigned_to") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "variance_workflow_event" ADD CONSTRAINT "variance_workflow_event_organization_id_resolved_by_fkey" FOREIGN KEY ("organization_id", "resolved_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Shared by native event fences and the tenant repository. Hash only original
-- facts and their current native eligibility; workflow events are never balances.
CREATE FUNCTION app_variance_workflow_source(org_uuid uuid,provider_text text,source_uuid uuid)
RETURNS TABLE(fingerprint text,state text,created_at timestamptz,source_audit_id uuid,original_reason text,original_action text)
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE
 original_variance variance%ROWTYPE;
 original_bank bank_reconciliation_entry%ROWTYPE;
 original_claim employee_compensation_claim%ROWTYPE;
 original_stocktake inventory_stocktake%ROWTYPE;
 source_body jsonb; related_body jsonb; journal_body jsonb; chosen_state text;
 source_time timestamptz; source_audit uuid; changed boolean; outstanding numeric; currencies integer; reason_text text; action_text text;
BEGIN
 IF org_uuid IS DISTINCT FROM NULLIF(current_setting('app.current_organization_id',true),'')::uuid THEN RETURN; END IF;
 IF provider_text='OTA' THEN
  SELECT native_variance.* INTO original_variance FROM variance native_variance
   WHERE native_variance.organization_id=org_uuid AND native_variance.id=source_uuid AND native_variance.source_type='AIRBNB_SETTLEMENT';
  IF NOT FOUND THEN RETURN; END IF;
  SELECT to_jsonb(native_settlement) INTO related_body FROM airbnb_settlement native_settlement
   WHERE native_settlement.organization_id=org_uuid AND native_settlement.id=original_variance.source_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(native_opposite) ORDER BY native_opposite.id),'[]'::jsonb) INTO journal_body
   FROM financial_transaction native_opposite WHERE native_opposite.organization_id=org_uuid AND native_opposite.reverses_transaction_id IN(
    SELECT native_journal.id FROM financial_transaction native_journal WHERE native_journal.organization_id=org_uuid
     AND native_journal.reverses_transaction_id IS NULL AND EXISTS(SELECT 1 FROM posting native_posting
      WHERE native_posting.organization_id=org_uuid AND native_posting.transaction_id=native_journal.id
       AND native_posting.dimensions @> jsonb_build_object('airbnb_settlement_id',original_variance.source_id::text)));
  chosen_state:=CASE WHEN journal_body<>'[]'::jsonb THEN 'SOURCE_CHANGED'
   WHEN original_variance.expected_amount=original_variance.actual_amount THEN 'MATCHED' ELSE 'OPEN' END;
  source_body:=jsonb_build_object('variance',to_jsonb(original_variance),'settlement',related_body,'opposites',journal_body,'state',chosen_state);
  source_time:=original_variance.created_at;
  reason_text:=original_variance.reason;action_text:=original_variance.action;
 ELSIF provider_text='BANK' THEN
  SELECT native_bank.* INTO original_bank FROM bank_reconciliation_entry native_bank
   WHERE native_bank.organization_id=org_uuid AND native_bank.id=source_uuid AND native_bank.action='MATCH';
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(native_release) ORDER BY native_release.id),'[]'::jsonb) INTO related_body
   FROM bank_reconciliation_entry native_release WHERE native_release.organization_id=org_uuid AND native_release.previous_entry_id=source_uuid;
  changed:=related_body<>'[]'::jsonb OR EXISTS(SELECT 1 FROM bank_reconciliation_evidence native_witness
    WHERE native_witness.organization_id=org_uuid AND native_witness.entry_id=source_uuid
     AND NOT app_bank_statement_line_is_removed(org_uuid,native_witness.line_id))
   OR EXISTS(SELECT 1 FROM bank_reconciliation_allocation native_allocation
    WHERE native_allocation.organization_id=org_uuid AND native_allocation.entry_id=source_uuid AND(
     (native_allocation.line_id IS NOT NULL AND NOT app_bank_statement_line_is_current(org_uuid,native_allocation.line_id)) OR
     (native_allocation.posting_id IS NOT NULL AND native_allocation.source_snapshot->'reversalIds' IS DISTINCT FROM
      (SELECT COALESCE(jsonb_agg(native_opposite.id::text ORDER BY native_opposite.id),'[]'::jsonb)
       FROM posting native_posting JOIN financial_transaction native_opposite ON native_opposite.organization_id=org_uuid
        AND native_opposite.reverses_transaction_id=native_posting.transaction_id
       WHERE native_posting.organization_id=org_uuid AND native_posting.id=native_allocation.posting_id))));
  chosen_state:=CASE WHEN changed THEN 'SOURCE_CHANGED' WHEN (original_bank.snapshot->>'variance')::numeric=0 THEN 'MATCHED' ELSE 'OPEN' END;
  source_body:=jsonb_build_object('entry',to_jsonb(original_bank),'releases',related_body,'state',chosen_state);
  source_time:=original_bank.created_at;
  reason_text:=original_bank.reason;action_text:=original_bank.snapshot->>'varianceAction';
 ELSIF provider_text='STAFF' THEN
  SELECT native_claim.* INTO original_claim FROM employee_compensation_claim native_claim
   WHERE native_claim.organization_id=org_uuid AND native_claim.id=source_uuid;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('journal',to_jsonb(native_journal),'postings',
    (SELECT COALESCE(jsonb_agg(to_jsonb(native_posting) ORDER BY native_posting.id),'[]'::jsonb) FROM posting native_posting
     WHERE native_posting.organization_id=org_uuid AND native_posting.transaction_id=native_journal.id)) ORDER BY native_journal.id),'[]'::jsonb),
    MIN(native_journal.created_at),COALESCE(bool_or(NOT native_journal.sealed),false)
   INTO journal_body,source_time,changed FROM financial_transaction native_journal
   WHERE native_journal.organization_id=org_uuid AND EXISTS(SELECT 1 FROM posting native_posting
    WHERE native_posting.organization_id=org_uuid AND native_posting.transaction_id=native_journal.id
     AND native_posting.dimensions->>'employee_compensation_claim_id'=source_uuid::text);
  IF journal_body='[]'::jsonb THEN RETURN; END IF;
  SELECT COALESCE(sum(CASE WHEN native_posting.side='CREDIT' THEN native_posting.amount ELSE -native_posting.amount END),0),count(DISTINCT native_posting.currency)::integer
   INTO outstanding,currencies FROM posting native_posting JOIN ledger_account native_account
    ON native_account.organization_id=org_uuid AND native_account.id=native_posting.ledger_account_id
   WHERE native_posting.organization_id=org_uuid AND native_account.code='EMPLOYEE_PAYABLE'
    AND native_account.account_type='CLAIM_OWNERSHIP' AND native_account.normal_side='CREDIT'
    AND native_posting.dimensions->>'employee_compensation_claim_id'=source_uuid::text
    AND native_posting.dimensions->>'employee_person_id'=original_claim.person_id::text;
  SELECT native_audit.id,native_audit.after->'reconciliation'->'plan'->>'reason',native_audit.after->'reconciliation'->'plan'->>'varianceAction'
   INTO source_audit,reason_text,action_text FROM audit_log native_audit WHERE native_audit.organization_id=org_uuid
   AND native_audit.action='finance.employee_settlement.reconciled' AND native_audit.after->>'claimId'=source_uuid::text
   ORDER BY native_audit.id DESC LIMIT 1;
  chosen_state:=CASE WHEN changed OR currencies<>1 OR outstanding<0 THEN 'SOURCE_CHANGED' WHEN outstanding=0 THEN 'MATCHED' ELSE 'OPEN' END;
  source_body:=jsonb_build_object('claim',to_jsonb(original_claim),'journals',journal_body,'outstanding',outstanding,'sourceAuditId',source_audit,'state',chosen_state);
 ELSIF provider_text='INVENTORY' THEN
  SELECT native_stocktake.* INTO original_stocktake FROM inventory_stocktake native_stocktake
   WHERE native_stocktake.organization_id=org_uuid AND native_stocktake.id=source_uuid;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(native_movement) ORDER BY native_movement.id),'[]'::jsonb) INTO related_body
   FROM inventory_movement native_movement WHERE native_movement.organization_id=org_uuid AND native_movement.stocktake_id=source_uuid;
  chosen_state:=CASE WHEN original_stocktake.expected_quantity=original_stocktake.counted_quantity THEN 'MATCHED' ELSE 'OPEN' END;
  source_body:=jsonb_build_object('observation',to_jsonb(original_stocktake),'movement',related_body,'state',chosen_state);
  source_time:=original_stocktake.received_at;
  reason_text:=original_stocktake.note;
  IF chosen_state='OPEN' THEN SELECT 'INVENTORY_STOCKTAKE_ADJUSTMENT:'||native_movement.id::text INTO action_text
   FROM inventory_movement native_movement WHERE native_movement.organization_id=org_uuid AND native_movement.stocktake_id=source_uuid; END IF;
 ELSE
  -- Host modules must add real native references before these providers admit events.
  RETURN;
 END IF;
 RETURN QUERY SELECT encode(digest(convert_to(source_body::text,'UTF8'),'sha256'),'hex'),chosen_state,source_time,source_audit,reason_text,action_text;
END $$;

ALTER TABLE variance_workflow_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE variance_workflow_event FORCE ROW LEVEL SECURITY;
CREATE POLICY variance_workflow_event_tenant_isolation ON variance_workflow_event
 USING(organization_id=current_setting('app.current_organization_id',true)::uuid)
 WITH CHECK(organization_id=current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER variance_workflow_event_immutable BEFORE UPDATE OR DELETE ON variance_workflow_event
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

-- Existing monetary facts and legacy metadata become an immutable baseline.
CREATE TRIGGER variance_original_facts_immutable BEFORE UPDATE OR DELETE ON variance
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_variance_workflow_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE
 native_source record; previous_event variance_workflow_event%ROWTYPE; previous_version bigint;
 previous_status text; previous_assignee uuid; previous_action text; previous_resolver uuid; previous_resolution timestamptz;
 allowed_keys text[]; current_keys text[]; baseline_variance variance%ROWTYPE;
BEGIN
 IF NEW.provider NOT IN('OTA','BANK','STAFF','INVENTORY') OR NEW.version<1
  OR NEW.source_fingerprint!~'^[a-f0-9]{64}$' OR NEW.request_hash!~'^[a-f0-9]{64}$'
  OR NEW.reason<>btrim(NEW.reason) OR char_length(NEW.reason) NOT BETWEEN 6 AND 500
  OR (NEW.action IS NOT NULL AND (NEW.action<>btrim(NEW.action) OR char_length(NEW.action) NOT BETWEEN 1 AND 500))
  OR NEW.status NOT IN('OPEN','RESOLVED') OR NEW.operation NOT IN('ASSIGN','RESOLVE','REOPEN')
 THEN RAISE EXCEPTION 'variance workflow intent is incomplete'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account native_actor JOIN person native_person
  ON native_person.organization_id=native_actor.organization_id AND native_person.id=native_actor.person_id
  WHERE native_actor.organization_id=NEW.organization_id AND native_actor.id=NEW.actor_id
   AND native_actor.status='ACTIVE' AND native_person.archived_at IS NULL)
 THEN RAISE EXCEPTION 'variance workflow actor is unavailable'; END IF;
 IF ROW(NEW.variance_id,NEW.bank_entry_id,NEW.claim_id,NEW.stocktake_id) IS DISTINCT FROM ROW(
  CASE WHEN NEW.provider='OTA' THEN NEW.source_id END,CASE WHEN NEW.provider='BANK' THEN NEW.source_id END,
  CASE WHEN NEW.provider='STAFF' THEN NEW.source_id END,CASE WHEN NEW.provider='INVENTORY' THEN NEW.source_id END)
 THEN RAISE EXCEPTION 'variance workflow must retain its exact native source'; END IF;
 IF NEW.provider<>'STAFF' AND NEW.source_audit_id IS NOT NULL THEN RAISE EXCEPTION 'variance workflow audit source is unrelated'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':variance-workflow-source:'||NEW.provider||':'||NEW.source_id::text,0));
 SELECT native_fact.* INTO native_source FROM app_variance_workflow_source(NEW.organization_id,NEW.provider,NEW.source_id) native_fact;
 IF NOT FOUND OR native_source.state<>'OPEN' OR native_source.fingerprint IS DISTINCT FROM NEW.source_fingerprint
  OR native_source.source_audit_id IS DISTINCT FROM NEW.source_audit_id
 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='variance_workflow_source_fence',MESSAGE='variance workflow source changed'; END IF;
 SELECT native_event.* INTO previous_event FROM variance_workflow_event native_event
  WHERE native_event.organization_id=NEW.organization_id AND native_event.provider=NEW.provider AND native_event.source_id=NEW.source_id
  ORDER BY native_event.version DESC LIMIT 1;
 previous_version:=CASE WHEN FOUND THEN previous_event.version ELSE 0 END;
 IF previous_version=9223372036854775807 OR NEW.version<>previous_version+1 THEN RAISE EXCEPTION 'variance workflow version conflict'; END IF;
 IF previous_version=0 THEN
  IF NEW.provider='OTA' THEN
   SELECT native_variance.* INTO baseline_variance FROM variance native_variance
    WHERE native_variance.organization_id=NEW.organization_id AND native_variance.id=NEW.source_id;
   previous_status:=baseline_variance.status;previous_assignee:=baseline_variance.assigned_to;previous_action:=baseline_variance.action;
   previous_resolver:=baseline_variance.resolved_by;previous_resolution:=baseline_variance.resolved_at;
  ELSE
   previous_status:='OPEN';previous_assignee:=NULL;previous_action:=native_source.original_action;previous_resolver:=NULL;previous_resolution:=NULL;
  END IF;
 ELSE
  previous_status:=CASE WHEN previous_event.source_fingerprint=NEW.source_fingerprint THEN previous_event.status ELSE 'OPEN' END;
  previous_assignee:=previous_event.assigned_to;previous_action:=CASE WHEN previous_event.source_fingerprint=NEW.source_fingerprint THEN previous_event.action ELSE native_source.original_action END;
  previous_resolver:=CASE WHEN previous_event.source_fingerprint=NEW.source_fingerprint THEN previous_event.resolved_by END;
  previous_resolution:=CASE WHEN previous_event.source_fingerprint=NEW.source_fingerprint THEN previous_event.resolved_at END;
 END IF;
 IF NEW.operation='ASSIGN' AND NEW.assigned_to IS NOT NULL AND NOT EXISTS(SELECT 1 FROM user_account native_account
  JOIN person native_person ON native_person.organization_id=native_account.organization_id AND native_person.id=native_account.person_id
  WHERE native_account.organization_id=NEW.organization_id AND native_account.id=NEW.assigned_to
   AND native_account.status='ACTIVE' AND native_person.archived_at IS NULL)
 THEN RAISE EXCEPTION 'variance workflow assignee is unavailable'; END IF;
 allowed_keys:=ARRAY['operation','reason','source','sourceFingerprint','version',CASE WHEN NEW.operation='ASSIGN' THEN 'assignedTo' ELSE 'action' END];
 SELECT array_agg(native_key ORDER BY native_key) INTO current_keys FROM jsonb_object_keys(NEW.intent) native_key;
 SELECT array_agg(native_key ORDER BY native_key) INTO allowed_keys FROM unnest(allowed_keys) native_key;
 IF current_keys IS DISTINCT FROM allowed_keys OR jsonb_typeof(NEW.intent->'source')<>'object'
  OR NEW.intent->'source' IS DISTINCT FROM jsonb_build_object('provider',NEW.provider,'id',NEW.source_id::text)
  OR NEW.intent->>'operation' IS DISTINCT FROM NEW.operation OR NEW.intent->>'version' IS DISTINCT FROM previous_version::text
  OR jsonb_typeof(NEW.intent->'version')<>'string' OR NEW.intent->>'sourceFingerprint' IS DISTINCT FROM NEW.source_fingerprint
  OR NEW.intent->>'reason' IS DISTINCT FROM NEW.reason
  OR NEW.request_hash IS DISTINCT FROM encode(digest(convert_to(NEW.intent::text,'UTF8'),'sha256'),'hex')
 THEN RAISE EXCEPTION 'variance workflow native intent hash mismatch'; END IF;
 IF NEW.operation='ASSIGN' THEN
  IF previous_status<>'OPEN' OR NEW.status<>'OPEN' OR NEW.assigned_to IS NOT DISTINCT FROM previous_assignee
   OR NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL
   OR NEW.action IS DISTINCT FROM previous_action
   OR NEW.intent->'assignedTo' IS DISTINCT FROM COALESCE(to_jsonb(NEW.assigned_to::text),'null'::jsonb)
  THEN RAISE EXCEPTION 'variance workflow assignment conflicts with its retained history'; END IF;
 ELSIF NEW.operation='RESOLVE' THEN
  IF previous_status<>'OPEN' OR NEW.status<>'RESOLVED' OR NEW.assigned_to IS DISTINCT FROM previous_assignee
   OR NEW.resolved_by IS DISTINCT FROM NEW.actor_id OR NEW.resolved_at IS DISTINCT FROM NEW.created_at
   OR NEW.action IS NULL OR char_length(NEW.action)<6 OR NEW.intent->>'action' IS DISTINCT FROM NEW.action
  THEN RAISE EXCEPTION 'variance workflow resolution requires its exact original review and attributed action'; END IF;
 ELSE
  IF previous_status<>'RESOLVED' OR NEW.status<>'OPEN' OR NEW.assigned_to IS DISTINCT FROM previous_assignee
   OR NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL
   OR NEW.action IS NULL OR char_length(NEW.action)<6 OR NEW.intent->>'action' IS DISTINCT FROM NEW.action
  THEN RAISE EXCEPTION 'variance workflow reopen requires its exact original review and action'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER variance_workflow_event_guard BEFORE INSERT ON variance_workflow_event
 FOR EACH ROW EXECUTE FUNCTION app_variance_workflow_event_guard();

CREATE FUNCTION app_variance_workflow_event_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE native_source record; expected_action text;
BEGIN
 SELECT native_fact.* INTO native_source FROM app_variance_workflow_source(NEW.organization_id,NEW.provider,NEW.source_id) native_fact;
 IF NOT FOUND OR native_source.state<>'OPEN' OR native_source.fingerprint IS DISTINCT FROM NEW.source_fingerprint
  OR native_source.source_audit_id IS DISTINCT FROM NEW.source_audit_id
 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='variance_workflow_source_fence',MESSAGE='variance workflow source changed before completion'; END IF;
 expected_action:=(CASE WHEN NEW.provider='INVENTORY' THEN 'inventory' ELSE 'finance' END)||'.variance_workflow.'||lower(NEW.operation);
 IF NOT EXISTS(SELECT 1 FROM audit_log native_audit WHERE native_audit.organization_id=NEW.organization_id
  AND native_audit.actor_id=NEW.actor_id AND native_audit.resource_type='variance_workflow_event' AND native_audit.resource_id=NEW.id
  AND native_audit.action=expected_action AND native_audit.reason=NEW.reason
  AND native_audit.after @> jsonb_build_object('eventId',NEW.id::text,'provider',NEW.provider,'sourceId',NEW.source_id::text,
   'version',NEW.version::text,'operation',NEW.operation,'sourceFingerprint',NEW.source_fingerprint::text,
   'status',NEW.status,'assignedTo',NEW.assigned_to::text,'reason',NEW.reason,'action',NEW.action,'resolvedBy',NEW.resolved_by::text)
  AND (native_audit.after->>'resolvedAt')::timestamptz IS NOT DISTINCT FROM NEW.resolved_at)
 THEN RAISE EXCEPTION 'variance workflow attributed audit must commit with its native event'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER variance_workflow_event_complete AFTER INSERT ON variance_workflow_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_variance_workflow_event_complete();

COMMIT;
