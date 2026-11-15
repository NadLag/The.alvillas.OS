BEGIN;
-- A table-row composite has no original system tuple header; retain the actual stored grant xmin explicitly.
CREATE OR REPLACE FUNCTION app_guard_guest_identity_delegation_native() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original RECORD;
BEGIN
 SELECT g.*,g.xmin::text AS native_xmin INTO original FROM guest_hub_form_grant g WHERE g.organization_id=NEW.organization_id AND g.id=NEW.grant_id FOR SHARE OF g;
 IF NOT coalesce(original.id IS NOT NULL AND original.form_key='IDENTITY_DOCUMENTS' AND original.decision='GRANTED' AND NEW.created_at=original.created_at
  AND original.native_xmin=pg_current_xact_id()::xid::text
  AND app_guest_identity_delegated_policy(NEW.organization_id,original.reservation_id,NEW.archive_policy_id,NEW.archive_policy_version,NEW.archive_policy_snapshot,'documents.archive',NEW.created_at)
  AND app_guest_identity_delegated_policy(NEW.organization_id,original.reservation_id,NEW.retention_policy_id,NEW.retention_policy_version,NEW.retention_policy_snapshot,'documents.retention',NEW.created_at)
  AND NEW.archive_policy_snapshot->'value'->>'source'='NATIVE_DOCUMENT_ARCHIVE' AND NEW.archive_policy_snapshot->'value'->>'encryption'='APP_MANAGED_AEAD'
  AND NEW.archive_policy_snapshot->'value'->>'downloads'='AUTHORIZED_SERVER_PROXY' AND NEW.archive_policy_snapshot->'value'->>'history'='APPEND_ONLY'
  AND NEW.retention_policy_snapshot->'value'->>'source'='NATIVE_DOCUMENT_VERSIONS' AND NEW.retention_policy_snapshot->'value'->>'artifact_inheritance'='ORIGINAL_SIGNED_VERSION'
  AND NEW.retention_policy_snapshot->'value'->>'archive_tagging'='ALLOW'
 ,false) THEN RAISE EXCEPTION 'guest_identity_delegation_requires_atomic_original_grant_and_actual_canonical_archive_retention';END IF;
 RETURN NEW;
END $$;
COMMIT;
