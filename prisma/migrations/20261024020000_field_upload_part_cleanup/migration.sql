ALTER TABLE operation_evidence_upload ADD COLUMN part_upload_expires_at timestamptz(6);
CREATE INDEX operation_evidence_upload_cleanup_idx ON operation_evidence_upload
 (organization_id,status,cleaned_at,part_upload_expires_at,created_at);
CREATE FUNCTION app_operation_upload_lease_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.part_upload_expires_at IS DISTINCT FROM OLD.part_upload_expires_at THEN
  IF OLD.status <> 'OPEN' OR NEW.status <> 'OPEN' OR NEW.part_upload_expires_at IS NULL
   OR (OLD.part_upload_expires_at IS NOT NULL AND NEW.part_upload_expires_at < OLD.part_upload_expires_at)
  THEN RAISE EXCEPTION 'upload part lease cannot be shortened or changed after closure'; END IF;
 END IF;
 IF NEW.cleaned_at IS NOT NULL AND NEW.part_upload_expires_at IS NOT NULL AND NEW.cleaned_at < NEW.part_upload_expires_at
 THEN RAISE EXCEPTION 'upload part lease remains active'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER operation_evidence_upload_lease_guard BEFORE UPDATE ON operation_evidence_upload
 FOR EACH ROW EXECUTE FUNCTION app_operation_upload_lease_guard();
