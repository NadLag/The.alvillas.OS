-- CreateTable
CREATE TABLE "lead_work_entry" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "previous_id" UUID,
    "number" INTEGER NOT NULL,
    "subject_id" UUID NOT NULL,
    "previous_subject_id" UUID,
    "subject_number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "activity_type_key" TEXT,
    "occurred_at" TIMESTAMPTZ(6),
    "reminder_state" TEXT,
    "due_at" TIMESTAMPTZ(6),
    "recipient_id" UUID,
    "representative_id" UUID,
    "representative_person_id" UUID,
    "source_payload_sha256" TEXT NOT NULL,
    "source_profile_id" UUID,
    "source_stage_id" UUID,
    "source_assignment_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "payload_schema_version" INTEGER NOT NULL DEFAULT 1,
    "encrypted_payload" BYTEA NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "capture_policy_id" UUID NOT NULL,
    "capture_policy_version" INTEGER NOT NULL,
    "capture_policy_snapshot" JSONB NOT NULL,
    "authorization_cap" JSONB NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "lead_work_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_work_entry_organization_id_lead_id_kind_number_idx" ON "lead_work_entry"("organization_id", "lead_id", "kind", "number");

-- CreateIndex
CREATE INDEX "lead_work_entry_organization_id_kind_due_at_id_idx" ON "lead_work_entry"("organization_id", "kind", "due_at", "id");

-- CreateIndex
CREATE INDEX "lead_work_entry_organization_id_created_at_id_idx" ON "lead_work_entry"("organization_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_work_entry_organization_id_id_key" ON "lead_work_entry"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_work_entry_organization_id_lead_id_id_key" ON "lead_work_entry"("organization_id", "lead_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_work_entry_organization_id_lead_id_number_key" ON "lead_work_entry"("organization_id", "lead_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "lead_work_entry_organization_id_lead_id_subject_id_subject__key" ON "lead_work_entry"("organization_id", "lead_id", "subject_id", "subject_number");

-- CreateIndex
CREATE UNIQUE INDEX "lead_work_entry_organization_id_command_key_key" ON "lead_work_entry"("organization_id", "command_key");

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_entry_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_entry_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "lead"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_previous_fk" FOREIGN KEY ("organization_id", "lead_id", "previous_id") REFERENCES "lead_work_entry"("organization_id", "lead_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_subject_fk" FOREIGN KEY ("organization_id", "lead_id", "subject_id") REFERENCES "lead_work_entry"("organization_id", "lead_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_previous_subject_fk" FOREIGN KEY ("organization_id", "lead_id", "previous_subject_id") REFERENCES "lead_work_entry"("organization_id", "lead_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_profile_fk" FOREIGN KEY ("organization_id", "lead_id", "source_profile_id") REFERENCES "lead_profile_revision"("organization_id", "lead_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_stage_fk" FOREIGN KEY ("organization_id", "lead_id", "source_stage_id") REFERENCES "lead_stage_revision"("organization_id", "lead_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_assignment_source_fk" FOREIGN KEY ("organization_id", "lead_id", "source_assignment_id") REFERENCES "lead_work_entry"("organization_id", "lead_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_entry_organization_id_created_by_fkey" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_entry_organization_id_recipient_id_fkey" FOREIGN KEY ("organization_id", "recipient_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_entry_organization_id_representative_id_fkey" FOREIGN KEY ("organization_id", "representative_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_entry_organization_id_representative_person_id_fkey" FOREIGN KEY ("organization_id", "representative_person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_entry_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_work_entry" ADD CONSTRAINT "lead_work_entry_organization_id_capture_policy_id_fkey" FOREIGN KEY ("organization_id", "capture_policy_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE lead_work_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_work_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_work_entry_tenant_isolation ON lead_work_entry
  USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER lead_work_entry_immutable BEFORE UPDATE OR DELETE ON lead_work_entry
  FOR EACH ROW EXECUTE FUNCTION app_lead_append_only();
ALTER TABLE lead_work_entry ADD CONSTRAINT lead_work_entry_shape CHECK(coalesce(
  number>0 AND number<2147483647 AND subject_number>0 AND subject_number<2147483647
  AND kind IN('ACTIVITY','REMINDER','ASSIGNMENT') AND payload_schema_version=1
  AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$'
  AND source_payload_sha256 ~ '^[a-f0-9]{64}$'
  AND octet_length(encrypted_payload) BETWEEN 64 AND 33024
  AND payload_sha256=encode(sha256(encrypted_payload),'hex')
  AND policy_version>0 AND capture_policy_version>0
  AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(capture_policy_snapshot)='object'
  AND jsonb_typeof(authorization_cap)='object' AND length(request_id) BETWEEN 1 AND 1000
  AND CASE kind
    WHEN 'ACTIVITY' THEN activity_type_key ~ '^[a-z][a-z0-9_]{0,119}$' AND occurred_at IS NOT NULL AND isfinite(occurred_at)
      AND reminder_state IS NULL AND due_at IS NULL AND recipient_id IS NULL AND representative_id IS NULL AND representative_person_id IS NULL
    WHEN 'REMINDER' THEN activity_type_key IS NULL AND occurred_at IS NULL
      AND reminder_state IN('OPEN','COMPLETED','CANCELLED') AND due_at IS NOT NULL AND isfinite(due_at) AND recipient_id IS NOT NULL
      AND representative_id IS NULL AND representative_person_id IS NULL
    WHEN 'ASSIGNMENT' THEN activity_type_key IS NULL AND occurred_at IS NULL AND reminder_state IS NULL AND due_at IS NULL AND recipient_id IS NULL
      AND ((representative_id IS NULL)=(representative_person_id IS NULL))
    ELSE false END,false));

CREATE FUNCTION app_guard_lead_work_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original lead%ROWTYPE; predecessor lead_work_entry%ROWTYPE; subject_root lead_work_entry%ROWTYPE;
  subject_predecessor lead_work_entry%ROWTYPE; assignment_predecessor lead_work_entry%ROWTYPE;
  rule config_rule%ROWTYPE; capture config_rule%ROWTYPE; current_profile uuid; current_stage uuid;
BEGIN
  SELECT * INTO original FROM lead WHERE organization_id=NEW.organization_id AND id=NEW.lead_id;
  IF original.id IS NULL OR NEW.source_payload_sha256 IS DISTINCT FROM original.payload_sha256
    OR NOT isfinite(NEW.created_at) OR NEW.created_at<original.created_at OR NEW.created_at>clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM user_account u JOIN person p ON p.organization_id=u.organization_id AND p.id=u.person_id
      WHERE u.organization_id=NEW.organization_id AND u.id=NEW.created_by AND u.status='ACTIVE' AND p.archived_at IS NULL)
  THEN RAISE EXCEPTION 'lead work requires its actual original tenant capture and active author'; END IF;

  SELECT * INTO predecessor FROM lead_work_entry WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND number<NEW.number ORDER BY number DESC LIMIT 1;
  IF NEW.previous_id IS NULL THEN
    IF NEW.number<>1 OR predecessor.id IS NOT NULL THEN RAISE EXCEPTION 'lead work requires its exact initial global position'; END IF;
  ELSIF predecessor.id IS DISTINCT FROM NEW.previous_id OR NEW.number<>predecessor.number+1 OR NEW.created_at<predecessor.created_at
  THEN RAISE EXCEPTION 'lead work requires its exact immutable global predecessor'; END IF;

  SELECT * INTO subject_root FROM lead_work_entry WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND id=NEW.subject_id;
  IF subject_root.id IS NULL OR subject_root.kind<>NEW.kind OR subject_root.subject_id<>subject_root.id
    OR subject_root.previous_subject_id IS NOT NULL OR subject_root.subject_number<>1 OR subject_root.number>NEW.number
  THEN RAISE EXCEPTION 'lead work requires its actual immutable subject root'; END IF;
  IF NEW.previous_subject_id IS NULL THEN
    IF NEW.subject_id<>NEW.id OR NEW.subject_number<>1 OR (NEW.kind='REMINDER' AND NEW.reminder_state<>'OPEN')
    THEN RAISE EXCEPTION 'lead work requires its exact initial subject position'; END IF;
  ELSE
    SELECT * INTO subject_predecessor FROM lead_work_entry
      WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND subject_id=NEW.subject_id AND subject_number<NEW.subject_number
      ORDER BY subject_number DESC LIMIT 1;
    IF subject_predecessor.id IS DISTINCT FROM NEW.previous_subject_id OR subject_predecessor.kind<>NEW.kind
      OR NEW.subject_number<>subject_predecessor.subject_number+1 OR subject_predecessor.number>=NEW.number
      OR NEW.created_at<subject_predecessor.created_at
    THEN RAISE EXCEPTION 'lead work requires its exact immutable subject predecessor'; END IF;
  END IF;

  SELECT * INTO assignment_predecessor FROM lead_work_entry
    WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND kind='ASSIGNMENT' AND number<NEW.number ORDER BY number DESC LIMIT 1;
  IF NEW.source_assignment_id IS DISTINCT FROM assignment_predecessor.id
    OR (NEW.kind='ASSIGNMENT' AND assignment_predecessor.id IS NOT NULL
      AND (NEW.subject_id<>assignment_predecessor.subject_id OR NEW.previous_subject_id IS DISTINCT FROM assignment_predecessor.id))
  THEN RAISE EXCEPTION 'lead work requires its actual prior representative position'; END IF;
  SELECT id INTO current_profile FROM lead_profile_revision WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id ORDER BY number DESC LIMIT 1;
  SELECT id INTO current_stage FROM lead_stage_revision WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id ORDER BY number DESC LIMIT 1;
  IF NEW.source_profile_id IS DISTINCT FROM current_profile OR NEW.source_stage_id IS DISTINCT FROM current_stage
  THEN RAISE EXCEPTION 'lead work requires its actual current native profile and stage'; END IF;

  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
  IF rule.id IS NULL OR rule.key<>'crm.lead_work' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
    OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED')
    OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
    OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
    OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_PRIVATE_LEAD_WORK'
    OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_ACTIVITIES_REMINDERS_ASSIGNMENTS'
  THEN RAISE EXCEPTION 'lead work requires its actual organization work policy'; END IF;
  IF NOT coalesce(jsonb_typeof(rule.value->'activity_types')='array' AND jsonb_array_length(rule.value->'activity_types')>0
    AND jsonb_typeof(rule.value->'activity_future_seconds')='number' AND rule.value->>'activity_future_seconds' ~ '^(0|[1-9][0-9]{0,9})$'
    AND (rule.value->>'activity_future_seconds')::numeric<=2147483647
    AND rule.value#>>'{reminders,past_due}' IN('REJECT','ALLOW_DUE')
    AND jsonb_typeof(rule.value#>'{reminders,maximum_future_seconds}')='number'
    AND rule.value#>>'{reminders,maximum_future_seconds}' ~ '^(0|[1-9][0-9]{0,9})$'
    AND (rule.value#>>'{reminders,maximum_future_seconds}')::numeric<=2147483647
    AND jsonb_typeof(rule.value#>'{reminders,transitions}')='array',false)
  THEN RAISE EXCEPTION 'lead work requires complete explicit activity and reminder rules'; END IF;
  SELECT * INTO capture FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.capture_policy_id;
  IF capture.id IS NULL OR capture.key<>'crm.lead_capture' OR capture.scope_type<>'organization' OR capture.scope_id IS NOT NULL
    OR capture.archived_at IS NOT NULL OR capture.lifecycle NOT IN('ACTIVE','RETIRED')
    OR NEW.created_at<capture.effective_from OR (capture.effective_to IS NOT NULL AND NEW.created_at>=capture.effective_to)
    OR NEW.capture_policy_version<>capture.version OR NEW.capture_policy_snapshot IS DISTINCT FROM jsonb_build_object('id',capture.id,'version',capture.version,'value',capture.value)
    OR capture.value->>'source' IS DISTINCT FROM 'NATIVE_PRIVATE_LEAD_CAPTURE'
    OR length(coalesce(capture.value->>'processing_approval_reference',''))=0
    OR NOT coalesce(capture.value->'channels' ? original.channel,false)
  THEN RAISE EXCEPTION 'lead work requires its actual original processing policy'; END IF;

  IF NEW.kind='ACTIVITY' THEN
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rule.value->'activity_types') AS activity(value) WHERE activity.value->>'key'=NEW.activity_type_key)
      OR NEW.occurred_at>NEW.created_at+make_interval(secs=>(rule.value->>'activity_future_seconds')::integer)
    THEN RAISE EXCEPTION 'lead activity requires its actual configured type and occurrence'; END IF;
  ELSIF NEW.kind='REMINDER' THEN
    IF NOT EXISTS(SELECT 1 FROM user_account u JOIN person p ON p.organization_id=u.organization_id AND p.id=u.person_id
      WHERE u.organization_id=NEW.organization_id AND u.id=NEW.recipient_id AND u.status='ACTIVE' AND p.archived_at IS NULL)
    THEN RAISE EXCEPTION 'lead reminder requires its actual active recipient'; END IF;
    IF NEW.previous_subject_id IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rule.value#>'{reminders,transitions}') AS transition(value)
        WHERE transition.value->>'from'=subject_predecessor.reminder_state AND transition.value->>'to'=NEW.reminder_state)
        OR (NEW.reminder_state<>'OPEN' AND (NEW.due_at IS DISTINCT FROM subject_predecessor.due_at OR NEW.recipient_id IS DISTINCT FROM subject_predecessor.recipient_id))
      THEN RAISE EXCEPTION 'lead reminder requires its configured native transition and original due source'; END IF;
    END IF;
    IF NEW.reminder_state='OPEN' AND (
      NEW.due_at>NEW.created_at+make_interval(secs=>(rule.value#>>'{reminders,maximum_future_seconds}')::integer)
      OR (rule.value#>>'{reminders,past_due}'='REJECT' AND NEW.due_at<NEW.created_at))
    THEN RAISE EXCEPTION 'lead reminder requires its actual configured due window'; END IF;
  ELSIF NEW.representative_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM user_account u JOIN person p ON p.organization_id=u.organization_id AND p.id=u.person_id
    WHERE u.organization_id=NEW.organization_id AND u.id=NEW.representative_id AND u.person_id=NEW.representative_person_id AND u.status='ACTIVE' AND p.archived_at IS NULL)
  THEN RAISE EXCEPTION 'lead assignment requires its actual active account and person'; END IF;

  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.actor_id=NEW.created_by
    AND l.action='crm.lead_work_recorded' AND l.resource_type='lead' AND l.resource_id=NEW.lead_id
    AND l.request_id=NEW.request_id AND l.occurred_at=NEW.created_at
    AND l.after=jsonb_build_object('leadId',NEW.lead_id,'entryId',NEW.id,'number',NEW.number,'subjectId',NEW.subject_id,'subjectNumber',NEW.subject_number,'kind',NEW.kind,
      'previousRevisionId',NEW.previous_id,'previousSubjectRevisionId',NEW.previous_subject_id,'commandHash',NEW.command_hash,'payloadSha256',NEW.payload_sha256,
      'policyId',NEW.policy_id,'capturePolicyId',NEW.capture_policy_id,'reviewFingerprint',NEW.review_fingerprint)
    AND l.xmin::text=pg_current_xact_id()::xid::text AND l.xmin::text=NEW.xmin::text)
  THEN RAISE EXCEPTION 'lead work requires its atomic private actor audit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id
    AND e.type='crm.lead_work_recorded' AND e.idempotency_key='crm.lead.work.recorded:'||NEW.id::text
    AND e.payload=jsonb_build_object('leadId',NEW.lead_id,'entryId',NEW.id,'subjectId',NEW.subject_id,'subjectNumber',NEW.subject_number,'kind',NEW.kind)
    AND e.occurred_at=NEW.created_at AND e.xmin::text=NEW.xmin::text)
  THEN RAISE EXCEPTION 'lead work requires its atomic identifier-only outbox event'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER lead_work_entry_guard AFTER INSERT ON lead_work_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_lead_work_entry();
