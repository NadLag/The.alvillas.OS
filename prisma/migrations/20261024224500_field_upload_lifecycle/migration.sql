ALTER TABLE "operation_evidence_upload"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lifecycle_checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "expired_at" TIMESTAMPTZ(6),
  ADD COLUMN "expiry_policy" JSONB,
  ADD CONSTRAINT "operation_evidence_upload_generation_positive" CHECK ("generation" > 0),
  ADD CONSTRAINT "operation_evidence_upload_expiry_pair" CHECK (("expired_at" IS NULL) = ("expiry_policy" IS NULL));

CREATE INDEX "operation_evidence_upload_lifecycle_idx"
  ON "operation_evidence_upload" ("organization_id", "status", "lifecycle_checked_at", "id");

CREATE OR REPLACE FUNCTION app_operation_upload_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recovery boolean := false;
BEGIN
 IF TG_OP='INSERT' AND (NEW.generation<>1 OR NEW.expired_at IS NOT NULL OR NEW.expiry_policy IS NOT NULL)
 THEN RAISE EXCEPTION 'upload must begin in its original generation'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.organization_id,NEW.actor_id,NEW.task_id,NEW.local_id,NEW.device_id,NEW.manifest,NEW.manifest_hash,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.actor_id,OLD.task_id,OLD.local_id,OLD.device_id,OLD.manifest,OLD.manifest_hash,OLD.created_at)
   OR (OLD.evidence_id IS NOT NULL AND NEW.evidence_id IS DISTINCT FROM OLD.evidence_id)
   OR (OLD.attached_at IS NOT NULL AND NEW.attached_at IS DISTINCT FROM OLD.attached_at)
  THEN RAISE EXCEPTION 'upload provenance is immutable'; END IF;
  recovery := OLD.generation<2147483647 AND NEW.generation::bigint=OLD.generation::bigint+1
   AND OLD.status='CANCELLED' AND OLD.expired_at IS NOT NULL AND OLD.expiry_policy IS NOT NULL
   AND OLD.cleaned_at IS NOT NULL AND OLD.ready_at IS NULL AND OLD.evidence_id IS NULL
   AND (OLD.part_upload_expires_at IS NULL OR OLD.part_upload_expires_at<=OLD.cleaned_at)
   AND NEW.status='OPEN' AND NEW.ready_at IS NULL AND NEW.evidence_id IS NULL AND NEW.attached_at IS NULL
   AND NEW.cleaned_at IS NULL AND NEW.part_upload_expires_at IS NULL
   AND NEW.expired_at IS NULL AND NEW.expiry_policy IS NULL AND NEW.last_activity_at>=OLD.cleaned_at;
  IF NEW.generation<>OLD.generation AND NOT recovery THEN RAISE EXCEPTION 'invalid upload generation transition'; END IF;
  IF NEW.last_activity_at<OLD.last_activity_at THEN RAISE EXCEPTION 'upload activity cannot move backwards'; END IF;
  IF NOT recovery THEN
   IF (OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at)
    OR (OLD.cleaned_at IS NOT NULL AND NEW.cleaned_at IS DISTINCT FROM OLD.cleaned_at)
   THEN RAISE EXCEPTION 'upload provenance is immutable'; END IF;
   IF (NEW.expired_at IS DISTINCT FROM OLD.expired_at OR NEW.expiry_policy IS DISTINCT FROM OLD.expiry_policy) AND NOT (
    OLD.status='OPEN' AND NEW.status='CANCELLED' AND OLD.expired_at IS NULL AND OLD.expiry_policy IS NULL
    AND NEW.expired_at IS NOT NULL AND NEW.expiry_policy IS NOT NULL
   ) THEN RAISE EXCEPTION 'upload expiry provenance is immutable'; END IF;
   IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='OPEN' AND NEW.status IN ('READY','CANCELLED')) OR
    (OLD.status='READY' AND NEW.status IN ('ATTACHED','CANCELLED'))
   ) THEN RAISE EXCEPTION 'invalid upload transition'; END IF;
  END IF;
 END IF;
 IF NEW.evidence_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM operation_task_evidence WHERE id=NEW.evidence_id AND organization_id=NEW.organization_id
   AND task_id=NEW.task_id AND created_by=NEW.actor_id
   AND sha256=NEW.manifest->>'sha256' AND content_type=NEW.manifest->>'contentType'
   AND size=(NEW.manifest->>'size')::integer
   AND storage_key=NEW.organization_id::text||'/tasks/'||NEW.task_id::text||'/uploads/'||NEW.id::text
 ) THEN RAISE EXCEPTION 'upload evidence tenant or actor mismatch'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_operation_upload_lease_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Generation recovery is fenced by app_operation_upload_guard. Existing
 -- signatures address the previous generation's distinct storage keys.
 IF NEW.generation<>OLD.generation THEN RETURN NEW; END IF;
 IF NEW.part_upload_expires_at IS DISTINCT FROM OLD.part_upload_expires_at THEN
  IF OLD.status <> 'OPEN' OR NEW.status <> 'OPEN' OR NEW.part_upload_expires_at IS NULL
   OR (OLD.part_upload_expires_at IS NOT NULL AND NEW.part_upload_expires_at < OLD.part_upload_expires_at)
  THEN RAISE EXCEPTION 'upload part lease cannot be shortened or changed after closure'; END IF;
 END IF;
 IF NEW.cleaned_at IS NOT NULL AND NEW.part_upload_expires_at IS NOT NULL AND NEW.cleaned_at < NEW.part_upload_expires_at
 THEN RAISE EXCEPTION 'upload part lease remains active'; END IF;
 RETURN NEW;
END $$;
