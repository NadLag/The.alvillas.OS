BEGIN;
-- A native original keeps the union of its signed delegation's classifications
-- and the actual canonical archive rule at admission. Later configuration
-- cannot silently remove a protection retained by the original grant.
CREATE FUNCTION app_guard_guest_identity_original_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original document_admission%ROWTYPE;root document%ROWTYPE;delegation guest_hub_identity_document_delegation%ROWTYPE;required TEXT[];
BEGIN
 SELECT * INTO original FROM document_admission WHERE organization_id=NEW.organization_id AND id=NEW.admission_id;
 SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
 SELECT d.* INTO delegation FROM guest_hub_identity_document_file f
  JOIN guest_hub_identity_document_capture c ON(c.organization_id,c.id)=(f.organization_id,f.capture_id)
  JOIN guest_hub_identity_document_delegation d ON(d.organization_id,d.grant_id)=(c.organization_id,c.grant_id)
  WHERE f.organization_id=NEW.organization_id AND f.id=NEW.file_id;
 SELECT ARRAY(SELECT DISTINCT value COLLATE "C" FROM(
  SELECT jsonb_array_elements_text(type->'privacy') AS value FROM jsonb_array_elements(original.policy_snapshot->'value'->'types') type WHERE type->>'key'=root.type_key
  UNION ALL
  SELECT jsonb_array_elements_text(type->'privacy') AS value FROM jsonb_array_elements(delegation.archive_policy_snapshot->'value'->'types') type WHERE type->>'key'=root.type_key
 ) classes ORDER BY value COLLATE "C") INTO required;
 IF NOT coalesce(root.id IS NOT NULL AND delegation.grant_id IS NOT NULL AND cardinality(required)>0
  AND root.privacy=required AND 'sensitive'=ANY(required) AND NOT 'financial'=ANY(required)
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(original.policy_snapshot->'value'->'types') type WHERE type->>'key'=root.type_key)
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(delegation.archive_policy_snapshot->'value'->'types') type WHERE type->>'key'=root.type_key),false)
 THEN RAISE EXCEPTION 'native_identity_original_retains_captured_and_current_privacy';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_identity_original_privacy_guard BEFORE INSERT ON guest_hub_identity_document_admission FOR EACH ROW EXECUTE FUNCTION app_guard_guest_identity_original_privacy();
COMMIT;
