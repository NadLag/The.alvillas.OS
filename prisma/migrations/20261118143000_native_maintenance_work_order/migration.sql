BEGIN;
-- CreateTable
CREATE TABLE "maintenance_work_order" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "native_fingerprint" CHAR(64) NOT NULL,
    "source_fingerprint" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_work_order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "maintenance_work_order_issue_history" ON "maintenance_work_order"("organization_id", "issue_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_work_order_org_id" ON "maintenance_work_order"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_work_order_actor_nonce" ON "maintenance_work_order"("organization_id", "actor_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "maintenance_work_order" ADD CONSTRAINT "maintenance_work_order_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_work_order" ADD CONSTRAINT "maintenance_work_order_task_fk" FOREIGN KEY ("organization_id", "id") REFERENCES "operation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_work_order" ADD CONSTRAINT "maintenance_work_order_issue_fk" FOREIGN KEY ("organization_id", "issue_id") REFERENCES "operation_issue"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_work_order" ADD CONSTRAINT "maintenance_work_order_actor_fk" FOREIGN KEY ("organization_id", "actor_id") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


CREATE FUNCTION app_maintenance_work_order_fingerprint(org_uuid uuid,issue_uuid uuid,task_uuid uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE original_issue operation_issue;source_task operation_task;work_task operation_task;villa property;
BEGIN
 IF org_uuid IS DISTINCT FROM NULLIF(current_setting('app.current_organization_id',true),'')::uuid THEN RETURN NULL;END IF;
 SELECT * INTO original_issue FROM operation_issue WHERE organization_id=org_uuid AND id=issue_uuid;
 SELECT * INTO source_task FROM operation_task WHERE organization_id=org_uuid AND id=original_issue.task_id AND property_id=original_issue.property_id AND archived_at IS NULL;
 SELECT * INTO work_task FROM operation_task WHERE organization_id=org_uuid AND id=task_uuid AND property_id=original_issue.property_id AND type='MAINTENANCE' AND archived_at IS NULL;
 SELECT * INTO villa FROM property WHERE organization_id=org_uuid AND id=original_issue.property_id AND archived_at IS NULL;
 IF original_issue.id IS NULL OR source_task.id IS NULL OR work_task.id IS NULL OR villa.id IS NULL THEN RETURN NULL;END IF;
 RETURN encode(digest(convert_to(jsonb_build_object('issue',to_jsonb(original_issue),'sourceTask',to_jsonb(source_task),'workTask',to_jsonb(work_task),'property',to_jsonb(villa))::text,'UTF8'),'sha256'),'hex');
END $$;

ALTER TABLE maintenance_work_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_order FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_work_order_tenant_isolation ON maintenance_work_order
 USING(organization_id=current_setting('app.current_organization_id',true)::uuid)
 WITH CHECK(organization_id=current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER maintenance_work_order_immutable BEFORE UPDATE OR DELETE ON maintenance_work_order
 FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_maintenance_work_order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE body jsonb;work_task operation_task;
BEGIN
 IF NEW.organization_id IS DISTINCT FROM NULLIF(current_setting('app.current_organization_id',true),'')::uuid THEN RAISE EXCEPTION 'maintenance_work_order_tenant_required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-work-order:'||NEW.organization_id::text||':'||NEW.id::text,0));
 body:=NEW.snapshot;
 SELECT * INTO work_task FROM operation_task WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR body->>'schemaVersion' IS DISTINCT FROM '1'
  OR body->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR body->>'actorId' IS DISTINCT FROM NEW.actor_id::text
  OR body->>'taskId' IS DISTINCT FROM NEW.id::text OR body->>'propertyId' IS DISTINCT FROM work_task.property_id::text
  OR body->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text OR body->>'nativeFingerprint' IS DISTINCT FROM NEW.native_fingerprint::text
  OR body->>'sourceFingerprint' IS DISTINCT FROM NEW.source_fingerprint::text OR body->>'reviewFingerprint' IS DISTINCT FROM NEW.review_fingerprint::text
  OR body->>'requestHash' IS DISTINCT FROM NEW.request_hash::text OR (body->>'createdAt')::timestamptz IS DISTINCT FROM NEW.created_at
  OR body->'intent'->>'taskId' IS DISTINCT FROM NEW.id::text OR body->'intent'->>'issueId' IS DISTINCT FROM NEW.issue_id::text
  OR body->'intent'->>'reason' IS DISTINCT FROM NEW.reason OR length(btrim(NEW.reason))<6
  OR NEW.native_fingerprint !~ '^[a-f0-9]{64}$' OR NEW.source_fingerprint !~ '^[a-f0-9]{64}$'
  OR NEW.review_fingerprint !~ '^[a-f0-9]{64}$' OR NEW.request_hash !~ '^[a-f0-9]{64}$'
  OR app_maintenance_work_order_fingerprint(NEW.organization_id,NEW.issue_id,NEW.id) IS DISTINCT FROM NEW.native_fingerprint::text
 THEN RAISE EXCEPTION 'maintenance_work_order_original_sources_required';END IF;
 IF EXISTS(SELECT 1 FROM outbox_event WHERE organization_id=NEW.organization_id AND idempotency_key='maintenance-work-order:'||NEW.actor_id::text||':'||NEW.idempotency_key::text) THEN RAISE EXCEPTION 'maintenance_work_order_command_closed';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_work_order_guard BEFORE INSERT ON maintenance_work_order FOR EACH ROW EXECUTE FUNCTION app_maintenance_work_order_guard();

CREATE FUNCTION app_maintenance_work_order_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source_xid xid;work_task operation_task;
BEGIN
 SELECT xmin INTO source_xid FROM maintenance_work_order WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT * INTO work_task FROM operation_task WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF app_maintenance_work_order_fingerprint(NEW.organization_id,NEW.issue_id,NEW.id) IS DISTINCT FROM NEW.native_fingerprint::text
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.actor_id AND a.resource_type='maintenance_work_order' AND a.resource_id=NEW.id AND a.action='maintenance.work_order.registered' AND a.reason=NEW.reason AND a.property_scope_id=work_task.property_id AND a.xmin=source_xid AND a.after @> jsonb_build_object('taskId',NEW.id::text,'issueId',NEW.issue_id::text))
  OR NOT EXISTS(SELECT 1 FROM outbox_event o WHERE o.organization_id=NEW.organization_id AND o.type='maintenance.work_order.registered' AND o.idempotency_key='maintenance-work-order:'||NEW.actor_id::text||':'||NEW.idempotency_key::text AND o.payload=NEW.snapshot AND o.xmin=source_xid)
 THEN RAISE EXCEPTION 'maintenance_work_order_original_audit_receipt_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER maintenance_work_order_complete AFTER INSERT ON maintenance_work_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_maintenance_work_order_complete();

CREATE FUNCTION app_maintenance_work_order_receipt_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.idempotency_key LIKE 'maintenance-work-order:%' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'maintenance_work_order_receipt_immutable';END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.type<>OLD.type OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.occurred_at<>OLD.occurred_at THEN RAISE EXCEPTION 'maintenance_work_order_receipt_immutable';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER maintenance_work_order_receipt_immutable BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_maintenance_work_order_receipt_immutable();

CREATE FUNCTION app_maintenance_work_order_negative_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE body jsonb;source_xid xid;
BEGIN
 IF NEW.idempotency_key NOT LIKE 'maintenance-work-order:%' THEN RETURN NULL;END IF;
 body:=NEW.payload;
 IF NEW.idempotency_key IS DISTINCT FROM 'maintenance-work-order:'||(body->>'actorId')||':'||(body->>'idempotencyKey') OR body->>'organizationId' IS DISTINCT FROM NEW.organization_id::text THEN RAISE EXCEPTION 'maintenance_work_order_receipt_identity_required';END IF;
 IF NEW.type='maintenance.work_order.registered' THEN
  IF NOT EXISTS(SELECT 1 FROM maintenance_work_order WHERE organization_id=NEW.organization_id AND id=(body->>'taskId')::uuid AND snapshot=body) THEN RAISE EXCEPTION 'maintenance_work_order_original_receipt_required';END IF;
 ELSIF NEW.type='maintenance.work_order.cancelled' THEN
  IF body->>'schemaVersion' IS DISTINCT FROM '1' OR(SELECT count(*) FROM jsonb_object_keys(body))<>6 THEN RAISE EXCEPTION 'maintenance_work_order_original_closure_required';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-work-order-command:'||NEW.organization_id::text||':'||(body->>'actorId')||':'||(body->>'idempotencyKey'),0));
  SELECT xmin INTO source_xid FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
  IF EXISTS(SELECT 1 FROM maintenance_work_order WHERE organization_id=NEW.organization_id AND actor_id=(body->>'actorId')::uuid AND idempotency_key=(body->>'idempotencyKey')::uuid)
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=(body->>'actorId')::uuid AND a.resource_type='maintenance_work_order_command' AND a.resource_id=(body->>'idempotencyKey')::uuid AND a.action='maintenance.work_order.cancelled' AND a.xmin=source_xid AND a.after=body)
  THEN RAISE EXCEPTION 'maintenance_work_order_original_closure_required';END IF;
 ELSE RAISE EXCEPTION 'maintenance_work_order_original_receipt_required';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER maintenance_work_order_negative_closure AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_maintenance_work_order_negative_closure();

COMMIT;
