CREATE TABLE operation_evidence_upload (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(), organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL, task_id uuid NOT NULL, local_id uuid NOT NULL, device_id text NOT NULL,
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'), manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','READY','ATTACHED','CANCELLED')),
 evidence_id uuid, ready_at timestamptz(6), attached_at timestamptz(6), cleaned_at timestamptz(6),
 created_at timestamptz(6) NOT NULL DEFAULT now(), updated_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT operation_evidence_upload_org_id_unique UNIQUE(organization_id,id),
 CONSTRAINT operation_evidence_upload_actor_key_unique UNIQUE(organization_id,actor_id,local_id),
 CONSTRAINT operation_evidence_upload_evidence_unique UNIQUE(evidence_id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 FOREIGN KEY(organization_id,task_id) REFERENCES operation_task(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 FOREIGN KEY(evidence_id) REFERENCES operation_task_evidence(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK(length(device_id) BETWEEN 8 AND 160),
 CHECK(manifest->>'localId'=local_id::text AND manifest->>'taskId'=task_id::text),
 CHECK((status='ATTACHED')=(evidence_id IS NOT NULL) AND (status='ATTACHED')=(attached_at IS NOT NULL)),
 CHECK(status NOT IN ('READY','ATTACHED') OR ready_at IS NOT NULL),
 CHECK(status<>'OPEN' OR ready_at IS NULL),
 CHECK(cleaned_at IS NULL OR status IN ('READY','ATTACHED','CANCELLED'))
);
CREATE INDEX operation_evidence_upload_org_status_created_idx ON operation_evidence_upload(organization_id,status,created_at);
ALTER TABLE operation_evidence_upload ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_evidence_upload FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_evidence_upload_tenant_isolation ON operation_evidence_upload
 USING(organization_id=current_setting('app.current_organization_id',true)::uuid)
 WITH CHECK(organization_id=current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER operation_evidence_upload_no_delete BEFORE DELETE ON operation_evidence_upload
 FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE FUNCTION app_operation_upload_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.organization_id,NEW.actor_id,NEW.task_id,NEW.local_id,NEW.device_id,NEW.manifest,NEW.manifest_hash,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.actor_id,OLD.task_id,OLD.local_id,OLD.device_id,OLD.manifest,OLD.manifest_hash,OLD.created_at)
   OR (OLD.evidence_id IS NOT NULL AND NEW.evidence_id IS DISTINCT FROM OLD.evidence_id)
   OR (OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at)
   OR (OLD.attached_at IS NOT NULL AND NEW.attached_at IS DISTINCT FROM OLD.attached_at)
   OR (OLD.cleaned_at IS NOT NULL AND NEW.cleaned_at IS DISTINCT FROM OLD.cleaned_at)
  THEN RAISE EXCEPTION 'upload provenance is immutable'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
   (OLD.status='OPEN' AND NEW.status IN ('READY','CANCELLED')) OR
   (OLD.status='READY' AND NEW.status IN ('ATTACHED','CANCELLED'))
  ) THEN RAISE EXCEPTION 'invalid upload transition'; END IF;
 END IF;
 IF NEW.evidence_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM operation_task_evidence WHERE id=NEW.evidence_id AND organization_id=NEW.organization_id
   AND task_id=NEW.task_id AND created_by=NEW.actor_id
   AND sha256=NEW.manifest->>'sha256' AND content_type=NEW.manifest->>'contentType'
   AND size=(NEW.manifest->>'size')::integer
   AND storage_key=NEW.organization_id::text||'/tasks/'||NEW.task_id::text||'/'||NEW.local_id::text
 ) THEN RAISE EXCEPTION 'upload evidence tenant or actor mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER operation_evidence_upload_guard BEFORE INSERT OR UPDATE ON operation_evidence_upload
 FOR EACH ROW EXECUTE FUNCTION app_operation_upload_guard();
