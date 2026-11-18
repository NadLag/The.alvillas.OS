BEGIN;

-- CreateTable
CREATE TABLE "maintenance_issue_context" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "previous_id" UUID,
    "version" BIGINT NOT NULL,
    "operation" VARCHAR(10) NOT NULL,
    "source_kind" VARCHAR(20) NOT NULL,
    "source_provider" VARCHAR(30),
    "source_id" UUID NOT NULL,
    "native_fingerprint" CHAR(64) NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "actor_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_issue_context_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "maintenance_issue_context_history" ON "maintenance_issue_context"("organization_id", "issue_id", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_issue_context_org_id" ON "maintenance_issue_context"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_issue_context_sequence" ON "maintenance_issue_context"("organization_id", "issue_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_issue_context_actor_nonce" ON "maintenance_issue_context"("organization_id", "actor_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_issue_context_predecessor" ON "maintenance_issue_context"("organization_id", "previous_id");

-- CreateIndex
CREATE UNIQUE INDEX "operation_issue_org_id" ON "operation_issue"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "maintenance_issue_context" ADD CONSTRAINT "maintenance_issue_context_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_issue_context" ADD CONSTRAINT "maintenance_issue_context_issue_fk" FOREIGN KEY ("organization_id", "issue_id") REFERENCES "operation_issue"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_issue_context" ADD CONSTRAINT "maintenance_issue_context_actor_fk" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_issue_context" ADD CONSTRAINT "maintenance_issue_context_previous_fk" FOREIGN KEY ("organization_id", "previous_id") REFERENCES "maintenance_issue_context"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


CREATE FUNCTION app_maintenance_issue_source_fingerprint(org_uuid uuid,issue_uuid uuid,kind_text text,provider_text text,source_uuid uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE issue operation_issue;task operation_task;property property;source_body jsonb;
BEGIN
 IF org_uuid IS DISTINCT FROM NULLIF(current_setting('app.current_organization_id',true),'')::uuid THEN RETURN NULL;END IF;
 SELECT * INTO issue FROM operation_issue i WHERE i.organization_id=org_uuid AND i.id=issue_uuid;
 SELECT * INTO task FROM operation_task t WHERE t.organization_id=org_uuid AND t.id=issue.task_id AND t.property_id=issue.property_id AND t.archived_at IS NULL;
 SELECT * INTO property FROM property p WHERE p.organization_id=org_uuid AND p.id=issue.property_id AND p.archived_at IS NULL;
 IF issue.id IS NULL OR task.id IS NULL OR property.id IS NULL THEN RETURN NULL;END IF;
 IF kind_text IN('PROPERTY','RESERVATION','GUEST','TASK','PERSON','SUPPLIER','EXPENSE','ASSET') AND provider_text IS NOT NULL THEN RETURN NULL;END IF;
 CASE kind_text
  WHEN 'PROPERTY' THEN SELECT to_jsonb(p) INTO source_body FROM property p WHERE p.organization_id=org_uuid AND p.id=source_uuid AND p.id=issue.property_id AND p.archived_at IS NULL;
  WHEN 'RESERVATION' THEN SELECT to_jsonb(r) INTO source_body FROM reservation r WHERE r.organization_id=org_uuid AND r.id=source_uuid AND r.property_id=issue.property_id AND r.archived_at IS NULL;
  WHEN 'GUEST' THEN SELECT to_jsonb(g) INTO source_body FROM guest g WHERE g.organization_id=org_uuid AND g.id=source_uuid AND g.archived_at IS NULL AND g.merged_into_id IS NULL;
  WHEN 'TASK' THEN SELECT to_jsonb(t) INTO source_body FROM operation_task t WHERE t.organization_id=org_uuid AND t.id=source_uuid AND t.property_id=issue.property_id AND t.archived_at IS NULL;
  WHEN 'PERSON' THEN SELECT to_jsonb(p) INTO source_body FROM person p WHERE p.organization_id=org_uuid AND p.id=source_uuid AND p.archived_at IS NULL;
  WHEN 'SUPPLIER' THEN SELECT to_jsonb(s) INTO source_body FROM supplier s WHERE s.organization_id=org_uuid AND s.id=source_uuid AND s.archived_at IS NULL;
  WHEN 'EXPENSE' THEN SELECT to_jsonb(e) INTO source_body FROM expense e WHERE e.organization_id=org_uuid AND e.id=source_uuid AND e.property_id=issue.property_id;
  WHEN 'ASSET' THEN RETURN NULL; -- F-AST-01 must register its real native asset source.
  WHEN 'PHOTO','DOCUMENT' THEN
   IF kind_text='PHOTO' AND provider_text='FIELD_EVIDENCE' THEN
    SELECT jsonb_build_object('evidence',to_jsonb(e),'task',to_jsonb(t)) INTO source_body FROM operation_task_evidence e
     JOIN operation_task t ON t.organization_id=e.organization_id AND t.id=e.task_id
     WHERE e.organization_id=org_uuid AND e.id=source_uuid AND t.property_id=issue.property_id AND t.archived_at IS NULL
      AND e.storage_key IS NOT NULL AND e.sha256 IS NOT NULL AND e.content_type IN('image/png','image/jpeg','image/webp');
   ELSIF provider_text='DOCUMENT_VERSION' THEN
    SELECT jsonb_build_object('version',to_jsonb(v),'root',to_jsonb(d),'admission',to_jsonb(a)) INTO source_body FROM document_version v
     JOIN document d ON d.organization_id=v.organization_id AND d.id=v.document_id
     JOIN document_upload_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
     WHERE v.organization_id=org_uuid AND v.id=source_uuid AND d.kind='FILE' AND d.archived_at IS NULL
      AND(d.property_id IS NULL OR d.property_id=issue.property_id)
      AND(kind_text='DOCUMENT' OR a.content_type IN('image/png','image/jpeg','image/webp'));
   ELSE RETURN NULL;END IF;
  ELSE RETURN NULL;
 END CASE;
 IF source_body IS NULL THEN RETURN NULL;END IF;
 RETURN encode(digest(convert_to(jsonb_build_object('issue',to_jsonb(issue),'task',to_jsonb(task),'property',to_jsonb(property),'source',source_body)::text,'UTF8'),'sha256'),'hex');
END $$;

ALTER TABLE maintenance_issue_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_issue_context FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_issue_context_tenant ON maintenance_issue_context
 USING(organization_id=current_setting('app.current_organization_id',true)::uuid)
 WITH CHECK(organization_id=current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER maintenance_issue_context_immutable BEFORE UPDATE OR DELETE ON maintenance_issue_context
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_maintenance_issue_context_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE previous maintenance_issue_context;existing maintenance_issue_context;reference jsonb;p jsonb;intent jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-issue-context:'||NEW.organization_id::text||':'||NEW.issue_id::text,0));
 IF EXISTS(SELECT 1 FROM outbox_event o WHERE o.organization_id=NEW.organization_id AND o.idempotency_key='maintenance-issue-context:'||NEW.actor_id::text||':'||NEW.idempotency_key::text) THEN RAISE EXCEPTION 'maintenance_issue_context_original_command_closed';END IF;
 SELECT * INTO previous FROM maintenance_issue_context c WHERE c.organization_id=NEW.organization_id AND c.issue_id=NEW.issue_id ORDER BY c.version DESC LIMIT 1;
 IF NEW.version<>COALESCE(previous.version,0)+1 OR NEW.previous_id IS DISTINCT FROM previous.id OR NEW.operation NOT IN('ATTACH','DETACH')
  OR NEW.reason<>btrim(NEW.reason) OR char_length(NEW.reason) NOT BETWEEN 6 AND 500
  OR NEW.native_fingerprint!~'^[a-f0-9]{64}$' OR NEW.source_fingerprint!~'^[a-f0-9]{64}$' OR NEW.review_fingerprint!~'^[a-f0-9]{64}$' OR NEW.request_hash!~'^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'maintenance_issue_context_original_intent_required';END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account u JOIN person p ON p.organization_id=u.organization_id AND p.id=u.person_id WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.status='ACTIVE' AND p.archived_at IS NULL)
 THEN RAISE EXCEPTION 'maintenance_issue_context_actor_unavailable';END IF;
 IF app_maintenance_issue_source_fingerprint(NEW.organization_id,NEW.issue_id,NEW.source_kind,NEW.source_provider,NEW.source_id) IS DISTINCT FROM NEW.native_fingerprint
 THEN RAISE EXCEPTION 'maintenance_issue_context_original_source_changed';END IF;
 SELECT * INTO existing FROM maintenance_issue_context c WHERE c.organization_id=NEW.organization_id AND c.issue_id=NEW.issue_id AND c.source_kind=NEW.source_kind AND c.source_provider IS NOT DISTINCT FROM NEW.source_provider AND c.source_id=NEW.source_id ORDER BY c.version DESC LIMIT 1;
 IF(NEW.operation='ATTACH' AND existing.operation='ATTACH') OR(NEW.operation='DETACH' AND existing.operation IS DISTINCT FROM 'ATTACH') THEN RAISE EXCEPTION 'maintenance_issue_context_attachment_changed';END IF;
 p:=NEW.snapshot;intent:=p->'intent';reference:=jsonb_build_object('kind',NEW.source_kind,'id',NEW.source_id::text)||CASE WHEN NEW.source_provider IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('provider',NEW.source_provider) END;
 IF p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR p->>'actorId' IS DISTINCT FROM NEW.actor_id::text
  OR p->>'contextId' IS DISTINCT FROM NEW.id::text OR p->>'previousId' IS DISTINCT FROM NEW.previous_id::text OR p->>'version' IS DISTINCT FROM NEW.version::text OR(p->>'createdAt')::timestamptz IS DISTINCT FROM NEW.created_at
  OR p->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text OR p->>'requestHash' IS DISTINCT FROM NEW.request_hash::text
  OR p->>'nativeFingerprint' IS DISTINCT FROM NEW.native_fingerprint::text OR p->>'sourceFingerprint' IS DISTINCT FROM NEW.source_fingerprint::text OR p->>'reviewFingerprint' IS DISTINCT FROM NEW.review_fingerprint::text
  OR intent IS DISTINCT FROM jsonb_build_object('issueId',NEW.issue_id::text,'expectedVersion',(NEW.version-1)::text,'operation',NEW.operation,'source',reference,'reason',NEW.reason)
 THEN RAISE EXCEPTION 'maintenance_issue_context_original_snapshot_required';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_issue_context_guard BEFORE INSERT ON maintenance_issue_context FOR EACH ROW EXECUTE FUNCTION app_maintenance_issue_context_guard();

CREATE FUNCTION app_maintenance_issue_context_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source_xid xid;action_text text;
BEGIN
 IF app_maintenance_issue_source_fingerprint(NEW.organization_id,NEW.issue_id,NEW.source_kind,NEW.source_provider,NEW.source_id) IS DISTINCT FROM NEW.native_fingerprint THEN RAISE EXCEPTION 'maintenance_issue_context_source_changed_before_commit';END IF;
 SELECT xmin INTO source_xid FROM maintenance_issue_context WHERE organization_id=NEW.organization_id AND id=NEW.id;
 action_text:=CASE NEW.operation WHEN 'ATTACH' THEN 'maintenance.issue.context.attached' ELSE 'maintenance.issue.context.detached' END;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.actor_id AND a.resource_type='maintenance_issue_context' AND a.resource_id=NEW.id AND a.action=action_text AND a.reason=NEW.reason AND a.xmin=source_xid AND a.after @> jsonb_build_object('issueId',NEW.issue_id::text,'version',NEW.version::text,'operation',NEW.operation,'sourceKind',NEW.source_kind))
  OR NOT EXISTS(SELECT 1 FROM outbox_event o WHERE o.organization_id=NEW.organization_id AND o.type='maintenance.issue.context.recorded' AND o.idempotency_key='maintenance-issue-context:'||NEW.actor_id::text||':'||NEW.idempotency_key::text AND o.payload=NEW.snapshot AND o.xmin=source_xid)
 THEN RAISE EXCEPTION 'maintenance_issue_context_original_audit_receipt_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER maintenance_issue_context_complete AFTER INSERT ON maintenance_issue_context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_maintenance_issue_context_complete();

CREATE FUNCTION app_maintenance_issue_context_receipt_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.idempotency_key LIKE 'maintenance-issue-context:%' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'maintenance_issue_context_receipt_immutable';END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.type<>OLD.type OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.occurred_at<>OLD.occurred_at THEN RAISE EXCEPTION 'maintenance_issue_context_receipt_immutable';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER maintenance_issue_context_receipt_immutable BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_maintenance_issue_context_receipt_immutable();

CREATE FUNCTION app_maintenance_issue_context_receipt_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p jsonb;source_xid xid;original maintenance_issue_context;
BEGIN
 IF NEW.idempotency_key NOT LIKE 'maintenance-issue-context:%' AND NEW.type NOT IN('maintenance.issue.context.recorded','maintenance.issue.context.cancelled') THEN RETURN NULL;END IF;
 p:=NEW.payload;SELECT xmin INTO source_xid FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR NEW.idempotency_key IS DISTINCT FROM 'maintenance-issue-context:'||(p->>'actorId')||':'||(p->>'idempotencyKey')
 THEN RAISE EXCEPTION 'maintenance_issue_context_original_receipt_required';END IF;
 IF NEW.type='maintenance.issue.context.recorded' THEN
  SELECT * INTO original FROM maintenance_issue_context c WHERE c.organization_id=NEW.organization_id AND c.id=(p->>'contextId')::uuid;
  IF original.id IS NULL OR original.snapshot IS DISTINCT FROM p OR NOT EXISTS(SELECT 1 FROM maintenance_issue_context c WHERE c.organization_id=NEW.organization_id AND c.id=original.id AND c.xmin=source_xid) THEN RAISE EXCEPTION 'maintenance_issue_context_original_version_required';END IF;
 ELSIF NEW.type='maintenance.issue.context.cancelled' THEN
  IF NOT EXISTS(SELECT 1 FROM operation_issue i WHERE i.organization_id=NEW.organization_id AND i.id=(p->>'issueId')::uuid)
   OR EXISTS(SELECT 1 FROM maintenance_issue_context c WHERE c.organization_id=NEW.organization_id AND c.actor_id=(p->>'actorId')::uuid AND c.idempotency_key=(p->>'idempotencyKey')::uuid)
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=(p->>'actorId')::uuid AND a.resource_type='maintenance_issue_context_command' AND a.resource_id=(p->>'idempotencyKey')::uuid AND a.action=NEW.type AND a.after=p AND a.xmin=source_xid)
  THEN RAISE EXCEPTION 'maintenance_issue_context_original_negative_closure_required';END IF;
 ELSE RAISE EXCEPTION 'maintenance_issue_context_original_receipt_type_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER maintenance_issue_context_receipt_complete AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_maintenance_issue_context_receipt_complete();

COMMIT;
