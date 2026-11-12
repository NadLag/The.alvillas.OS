BEGIN;
-- CreateTable
CREATE TABLE "property_onboarding_activation_request" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "review_revision_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "encrypted_payload" BYTEA NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "payload_schema_version" INTEGER NOT NULL DEFAULT 1,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "property_onboarding_activation_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_onboarding_activation_event" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "previous_id" UUID,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "effect_kind" TEXT,
    "attempt" INTEGER,
    "result" JSONB,
    "result_fingerprint" TEXT,
    "failure_code" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6),
    "actor_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "property_onboarding_activation_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "onboarding_activation_session_history_idx" ON "property_onboarding_activation_request"("organization_id", "session_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "onboarding_activation_creator_history_idx" ON "property_onboarding_activation_request"("organization_id", "created_by", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_activation_org_id_key" ON "property_onboarding_activation_request"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_activation_org_nonce_key" ON "property_onboarding_activation_request"("organization_id", "command_key");

-- CreateIndex
CREATE INDEX "onboarding_activation_event_history_idx" ON "property_onboarding_activation_event"("organization_id", "activation_id", "sequence" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_activation_event_org_id_key" ON "property_onboarding_activation_event"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_activation_event_org_run_id_key" ON "property_onboarding_activation_event"("organization_id", "activation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_activation_event_sequence_key" ON "property_onboarding_activation_event"("organization_id", "activation_id", "sequence");

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_request" ADD CONSTRAINT "onboarding_activation_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_request" ADD CONSTRAINT "onboarding_activation_session_fk" FOREIGN KEY ("organization_id", "session_id") REFERENCES "property_onboarding_session"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_request" ADD CONSTRAINT "onboarding_activation_review_fk" FOREIGN KEY ("organization_id", "session_id", "review_revision_id") REFERENCES "property_onboarding_revision"("organization_id", "session_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_request" ADD CONSTRAINT "onboarding_activation_owner_fk" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "owner"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_request" ADD CONSTRAINT "onboarding_activation_property_fk" FOREIGN KEY ("organization_id", "property_id") REFERENCES "property"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_request" ADD CONSTRAINT "onboarding_activation_creator_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_request" ADD CONSTRAINT "onboarding_activation_policy_fk" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_event" ADD CONSTRAINT "onboarding_activation_event_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_event" ADD CONSTRAINT "onboarding_activation_event_request_fk" FOREIGN KEY ("organization_id", "activation_id") REFERENCES "property_onboarding_activation_request"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_event" ADD CONSTRAINT "onboarding_activation_event_previous_fk" FOREIGN KEY ("organization_id", "activation_id", "previous_id") REFERENCES "property_onboarding_activation_event"("organization_id", "activation_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property_onboarding_activation_event" ADD CONSTRAINT "onboarding_activation_event_actor_fk" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


CREATE UNIQUE INDEX onboarding_activation_org_review_key ON property_onboarding_activation_request(organization_id,review_revision_id);

ALTER TABLE property_onboarding_activation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_onboarding_activation_request FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_activation_request_tenant ON property_onboarding_activation_request
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE property_onboarding_activation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_onboarding_activation_event FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_activation_event_tenant ON property_onboarding_activation_event
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER onboarding_activation_request_immutable BEFORE UPDATE OR DELETE ON property_onboarding_activation_request FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();
CREATE TRIGGER onboarding_activation_event_immutable BEFORE UPDATE OR DELETE ON property_onboarding_activation_event FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

ALTER TABLE property_onboarding_activation_request ADD CONSTRAINT onboarding_activation_request_shape CHECK(coalesce(
 isfinite(created_at) AND payload_schema_version=1 AND octet_length(encrypted_payload) BETWEEN 64 AND 134217728
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
 AND length(request_id) BETWEEN 1 AND 1000,false));

ALTER TABLE property_onboarding_activation_event ADD CONSTRAINT onboarding_activation_event_shape CHECK(coalesce(
 sequence>0 AND isfinite(occurred_at) AND actor_id IS NOT NULL AND length(request_id) BETWEEN 1 AND 1000
 AND (next_attempt_at IS NULL OR isfinite(next_attempt_at) AND next_attempt_at>occurred_at)
 AND CASE WHEN type='REQUESTED' THEN sequence=1 AND previous_id IS NULL AND effect_kind IS NULL AND attempt IS NULL AND result IS NULL AND result_fingerprint IS NULL AND failure_code IS NULL AND next_attempt_at IS NULL
 WHEN type='ACTIVATED' THEN sequence>1 AND previous_id IS NOT NULL AND effect_kind IS NULL AND attempt IS NULL AND jsonb_typeof(result)='object' AND result_fingerprint ~ '^[a-f0-9]{64}$' AND failure_code IS NULL AND next_attempt_at IS NULL
 ELSE sequence>1 AND previous_id IS NOT NULL AND effect_kind IN('WORKFLOWS','DOCUMENTS','EMAIL','TASKS','NOTIFICATION') AND attempt>0
  AND CASE WHEN type='STARTED' THEN result IS NULL AND result_fingerprint IS NULL AND failure_code IS NULL AND next_attempt_at IS NULL
  WHEN type='SUCCEEDED' THEN jsonb_typeof(result)='object' AND result_fingerprint ~ '^[a-f0-9]{64}$' AND failure_code IS NULL AND next_attempt_at IS NULL
  WHEN type IN('RETRY_SCHEDULED','BLOCKED','FAILED') THEN result IS NULL AND result_fingerprint IS NULL AND failure_code ~ '^[A-Z][A-Z0-9_]{0,95}$' AND (type='RETRY_SCHEDULED')=(next_attempt_at IS NOT NULL)
  ELSE false END END,false));

CREATE FUNCTION app_guard_onboarding_activation_request() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE reviewed property_onboarding_revision%ROWTYPE;head_id UUID;target property%ROWTYPE;rule config_rule%ROWTYPE;target_xmin TEXT;target_tuple TEXT;owner_xmin TEXT;owner_tuple TEXT;effect_order TEXT[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT id INTO head_id FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 SELECT * INTO reviewed FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND id=NEW.review_revision_id;
 SELECT * INTO target FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id FOR UPDATE;
 SELECT xmin::text,ctid::text INTO target_xmin,target_tuple FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id;
 SELECT xmin::text,ctid::text INTO owner_xmin,owner_tuple FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id AND archived_at IS NULL;
 IF reviewed.id IS NULL OR reviewed.id IS DISTINCT FROM head_id OR reviewed.step<>'REVIEW' OR reviewed.mode<>'VALIDATE'
  OR reviewed.session_id<>NEW.session_id OR reviewed.owner_id<>NEW.owner_id OR reviewed.property_id IS DISTINCT FROM NEW.property_id
  OR NEW.created_at<reviewed.created_at OR target.id IS NULL OR target.archived_at IS NOT NULL OR target.status NOT IN('DRAFT','ONBOARDING')
  OR owner_xmin IS NULL OR reviewed.source_snapshot#>>'{parent,property,xmin}' IS DISTINCT FROM target_xmin OR reviewed.source_snapshot#>>'{parent,property,tuple}' IS DISTINCT FROM target_tuple
  OR reviewed.source_snapshot#>>'{parent,owner,ownerXmin}' IS DISTINCT FROM owner_xmin OR reviewed.source_snapshot#>>'{parent,owner,ownerTuple}' IS DISTINCT FROM owner_tuple
  OR NOT EXISTS(SELECT 1 FROM property_owner WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND owner_id=NEW.owner_id AND archived_at IS NULL)
  OR NEW.source_snapshot IS DISTINCT FROM jsonb_build_object('source','CORE_ONBOARDING_VALIDATED_ACTIVATION','reviewRevisionId',reviewed.id,'reviewSourceFingerprint',reviewed.source_fingerprint,'reviewPayloadSha256',reviewed.payload_sha256)
 THEN RAISE EXCEPTION 'activation requires its actual current native Review and preparatory property'; END IF;
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
 IF coalesce(rule.id IS NULL OR rule.created_by IS NULL OR rule.key<>'onboarding.wizard' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
  OR rule.archived_at IS NOT NULL OR rule.lifecycle<>'ACTIVE' OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
  OR NEW.policy_id<>reviewed.policy_id OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM reviewed.policy_snapshot
  OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
  OR rule.value->'activation'->'modes' IS DISTINCT FROM '["BACKGROUND"]'::jsonb
  OR jsonb_typeof(rule.value->'activation'->'effects') IS DISTINCT FROM 'array' OR jsonb_array_length(rule.value->'activation'->'effects')<>5
  OR NOT (rule.value->'activation'->'effects' @> '["WORKFLOWS","DOCUMENTS","EMAIL","TASKS","NOTIFICATION"]'::jsonb)
  OR NOT (rule.value->'activation'->'retry'->>'max_attempts' ~ '^[0-9]+$') OR (rule.value->'activation'->'retry'->>'max_attempts')::int NOT BETWEEN 1 AND 25
  OR NOT (rule.value->'activation'->'retry'->>'backoff_seconds' ~ '^[0-9]+$') OR (rule.value->'activation'->'retry'->>'backoff_seconds')::int NOT BETWEEN 1 AND 3600,true)
 THEN RAISE EXCEPTION 'activation requires its actual approved Review policy and explicit background effects'; END IF;
 SELECT array_agg(value ORDER BY position) INTO effect_order FROM jsonb_array_elements_text(rule.value->'activation'->'effects') WITH ORDINALITY AS effects(value,position);
 IF array_position(effect_order,'WORKFLOWS')>=array_position(effect_order,'DOCUMENTS') OR array_position(effect_order,'WORKFLOWS')>=array_position(effect_order,'TASKS') OR array_position(effect_order,'DOCUMENTS')>=array_position(effect_order,'EMAIL') OR array_position(effect_order,'EMAIL')>=array_position(effect_order,'NOTIFICATION') OR array_position(effect_order,'TASKS')>=array_position(effect_order,'NOTIFICATION') THEN RAISE EXCEPTION 'activation policy requires dependency-ordered effects'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER onboarding_activation_request_native_guard BEFORE INSERT ON property_onboarding_activation_request FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_activation_request();

CREATE FUNCTION app_guard_onboarding_activation_event() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request property_onboarding_activation_request%ROWTYPE;head property_onboarding_activation_event%ROWTYPE;phase property_onboarding_activation_event%ROWTYPE;dependency TEXT;maximum INTEGER;activated property_onboarding_revision%ROWTYPE;request_xmin TEXT;activated_xmin TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:activation:'||NEW.activation_id::text,0));
 SELECT * INTO request FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND id=NEW.activation_id;
 SELECT xmin::text INTO request_xmin FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND id=NEW.activation_id;
 SELECT * INTO head FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id ORDER BY sequence DESC LIMIT 1;
 IF request.id IS NULL OR NEW.actor_id IS DISTINCT FROM request.created_by OR NEW.previous_id IS DISTINCT FROM head.id OR NEW.sequence<>coalesce(head.sequence,0)+1
  OR NEW.occurred_at<request.created_at OR (head.id IS NOT NULL AND NEW.occurred_at<head.occurred_at) OR head.type IN('ACTIVATED','FAILED')
 THEN RAISE EXCEPTION 'activation events require their actual consecutive immutable run head'; END IF;
 IF NEW.type='REQUESTED' THEN
  IF head.id IS NOT NULL OR NEW.occurred_at<>request.created_at OR NEW.request_id<>request.request_id OR request_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text THEN RAISE EXCEPTION 'activation requires its atomic initial request event'; END IF;
 ELSIF NEW.type='ACTIVATED' THEN
  FOREACH dependency IN ARRAY ARRAY['WORKFLOWS','DOCUMENTS','EMAIL','TASKS','NOTIFICATION'] LOOP
   SELECT * INTO phase FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id AND effect_kind=dependency ORDER BY sequence DESC LIMIT 1;
   IF phase.type IS DISTINCT FROM 'SUCCEEDED' THEN RAISE EXCEPTION 'activation requires every real effect receipt'; END IF;
  END LOOP;
  SELECT * INTO activated FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND id=(NEW.result->>'revisionId')::uuid;
  SELECT xmin::text INTO activated_xmin FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND id=(NEW.result->>'revisionId')::uuid;
  IF activated.id IS NULL OR activated.step<>'ACTIVATE' OR activated.mode<>'BACKGROUND' OR activated.session_id<>request.session_id OR activated.previous_id<>request.review_revision_id
   OR activated.owner_id<>request.owner_id OR activated.property_id<>request.property_id OR activated.created_by<>request.created_by
   OR activated.created_at<>NEW.occurred_at OR activated_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text
   OR NEW.result IS DISTINCT FROM jsonb_build_object('revisionId',activated.id,'activatedAt',NEW.occurred_at)
   OR NOT EXISTS(SELECT 1 FROM property WHERE organization_id=NEW.organization_id AND id=request.property_id AND archived_at IS NULL AND status='ACTIVE' AND xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'activation completion requires its atomic native revision and canonical operational property'; END IF;
 ELSE
  SELECT * INTO phase FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id AND effect_kind=NEW.effect_kind ORDER BY sequence DESC LIMIT 1;
  maximum=(request.policy_snapshot->'value'->'activation'->'retry'->>'max_attempts')::int;
  IF NEW.attempt>maximum THEN RAISE EXCEPTION 'activation attempt exceeds its approved retry policy'; END IF;
  IF NEW.type='STARTED' THEN
   IF phase.type IS NOT NULL AND phase.type NOT IN('RETRY_SCHEDULED','BLOCKED') OR NEW.attempt<>coalesce(phase.attempt,0)+1 OR phase.next_attempt_at>NEW.occurred_at THEN RAISE EXCEPTION 'activation effect requires an eligible next attempt'; END IF;
   FOREACH dependency IN ARRAY CASE NEW.effect_kind WHEN 'WORKFLOWS' THEN ARRAY[]::text[] WHEN 'DOCUMENTS' THEN ARRAY['WORKFLOWS'] WHEN 'EMAIL' THEN ARRAY['DOCUMENTS'] WHEN 'TASKS' THEN ARRAY['WORKFLOWS'] ELSE ARRAY['EMAIL','TASKS'] END LOOP
    IF (SELECT type FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id AND effect_kind=dependency ORDER BY sequence DESC LIMIT 1) IS DISTINCT FROM 'SUCCEEDED' THEN RAISE EXCEPTION 'activation effect requires successful dependencies'; END IF;
   END LOOP;
  ELSIF phase.type IS DISTINCT FROM 'STARTED' OR NEW.attempt IS DISTINCT FROM phase.attempt THEN RAISE EXCEPTION 'activation outcome requires its actual started attempt';
  ELSIF NEW.type='RETRY_SCHEDULED' AND (NEW.attempt>=maximum OR NEW.next_attempt_at<>NEW.occurred_at+make_interval(secs=>(request.policy_snapshot->'value'->'activation'->'retry'->>'backoff_seconds')::int)) THEN RAISE EXCEPTION 'activation retry requires its approved backoff and remaining attempts'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER onboarding_activation_event_native_guard BEFORE INSERT ON property_onboarding_activation_event FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_activation_event();

CREATE FUNCTION app_guard_onboarding_activation_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM property_onboarding_activation_event e WHERE e.organization_id=NEW.organization_id AND e.activation_id=NEW.id AND e.type='REQUESTED' AND e.sequence=1 AND e.xmin::text=NEW.xmin::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='onboarding.activation_requested' AND a.resource_type='onboarding' AND a.resource_id=NEW.session_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.created_at AND a.xmin::text=NEW.xmin::text
   AND a.after=jsonb_build_object('activationId',NEW.id,'sessionId',NEW.session_id,'reviewRevisionId',NEW.review_revision_id,'propertyId',NEW.property_id,'commandHash',NEW.command_hash,'payloadSha256',NEW.payload_sha256,'sourceFingerprint',NEW.source_fingerprint,'reviewFingerprint',NEW.review_fingerprint,'policyId',NEW.policy_id))
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='onboarding.activation_requested' AND e.idempotency_key='onboarding.activation:'||NEW.id::text AND e.occurred_at=NEW.created_at AND e.xmin::text=NEW.xmin::text AND e.payload=jsonb_build_object('sessionId',NEW.session_id,'activationId',NEW.id,'reviewRevisionId',NEW.review_revision_id,'propertyId',NEW.property_id))
 THEN RAISE EXCEPTION 'activation requires its atomic initial event, private audit and identifier-only outbox'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER onboarding_activation_birth_guard AFTER INSERT ON property_onboarding_activation_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_activation_birth();

CREATE FUNCTION app_guard_onboarding_activation_event_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request property_onboarding_activation_request%ROWTYPE;
BEGIN
 IF NEW.type='REQUESTED' THEN RETURN NULL; END IF;
 SELECT * INTO request FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND id=NEW.activation_id;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.actor_id AND a.action='onboarding.activation_event' AND a.resource_type='onboarding' AND a.resource_id=request.session_id AND a.request_id=NEW.request_id AND a.occurred_at=NEW.occurred_at AND a.xmin::text=NEW.xmin::text
  AND a.after=jsonb_build_object('activationId',NEW.activation_id,'eventId',NEW.id,'sequence',NEW.sequence,'type',NEW.type,'effectKind',NEW.effect_kind,'attempt',NEW.attempt,'resultFingerprint',NEW.result_fingerprint,'failureCode',NEW.failure_code))
 THEN RAISE EXCEPTION 'activation event requires its atomic private evidence audit'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER onboarding_activation_event_guard AFTER INSERT ON property_onboarding_activation_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_activation_event_evidence();

COMMIT;
