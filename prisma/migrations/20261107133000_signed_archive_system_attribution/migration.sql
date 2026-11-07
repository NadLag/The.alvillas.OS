BEGIN;

-- Automatic signed-artifact history cannot borrow its original initiating human actor.
-- Existing human document actions retain their original guard behavior.
CREATE OR REPLACE FUNCTION app_document_action_required(organization_uuid uuid,document_uuid uuid,action_key text,actor_uuid uuid,at_time timestamptz,version_uuid uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM document_action a JOIN audit_log l ON l.organization_id=a.organization_id AND l.resource_id=a.id
    AND l.resource_type='document' AND l.action='documents.'||lower(action_key)
    WHERE a.organization_id=organization_uuid AND a.document_id=document_uuid AND a.action=action_key AND a.occurred_at=at_time
    AND (a.actor_id=actor_uuid AND NOT EXISTS(SELECT 1 FROM signature_signed_artifact asset WHERE asset.organization_id=organization_uuid AND asset.document_id=document_uuid) OR a.actor_id IS NULL AND app_signed_archive_action_valid(a) AND EXISTS(SELECT 1 FROM document root WHERE root.organization_id=organization_uuid AND root.id=document_uuid AND root.created_by=actor_uuid))
    AND (version_uuid IS NULL OR a.after->>(CASE WHEN action_key='ADMITTED' THEN 'admissionId' ELSE 'versionId' END)=version_uuid::text)
    AND l.actor_id IS NOT DISTINCT FROM a.actor_id AND l.occurred_at=a.occurred_at AND l.after->>'documentId'=a.document_id::text
    AND l.after->>'commandHash'=a.command_hash AND a.xmin::text=pg_current_xact_id()::xid::text AND l.xmin::text=a.xmin::text)
  THEN RAISE EXCEPTION 'document mutation requires atomic private history and canonical audit'; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_guard_document_action() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM signature_signed_artifact asset WHERE asset.organization_id=NEW.organization_id AND asset.document_id=NEW.document_id) AND NOT app_signed_archive_action_valid(NEW) THEN RAISE EXCEPTION 'signed artifact history requires its actual system attribution'; END IF;
  IF NEW.actor_id IS NULL AND NOT app_signed_archive_action_valid(NEW) THEN RAISE EXCEPTION 'system document action requires its actual retained signed artifact'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_id=NEW.id AND l.resource_type='document'
    AND l.action='documents.'||lower(NEW.action) AND l.actor_id IS NOT DISTINCT FROM NEW.actor_id AND l.occurred_at=NEW.occurred_at
    AND l.after->>'documentId'=NEW.document_id::text AND l.after->>'commandHash'=NEW.command_hash
    AND l.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'each private document action requires its own atomic canonical audit'; END IF; RETURN NULL;
END $$;

COMMIT;
