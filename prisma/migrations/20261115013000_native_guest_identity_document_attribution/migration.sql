BEGIN;
-- A delegated staff principal authorizes collection; the physical submitter is
-- the guest capability. A null human audit actor requires this exact native birth.
CREATE FUNCTION app_guest_identity_archive_action_valid(a document_action,l audit_log) RETURNS boolean LANGUAGE SQL STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(a.actor_id IS NOT NULL AND a.action IN('CREATED','ADMITTED','VERSION_ADDED') AND l.actor_id IS NULL
  AND a.after->'guestIdentityOrigin'=app_guest_identity_document_origin(a.organization_id,b.file_id)
  AND l.after=jsonb_build_object('documentId',a.document_id::text,'commandHash',a.command_hash,'guestIdentityOrigin',app_guest_identity_document_origin(a.organization_id,b.file_id))
  AND l.organization_id=a.organization_id AND l.resource_id=a.id AND l.resource_type='document' AND l.action='documents.'||lower(a.action) AND l.occurred_at=a.occurred_at
  AND l.property_scope_id=c.property_id AND a.command_key=b.file_id AND a.command_hash=d.command_hash AND a.reason=d.reason AND a.source_fingerprint=d.source_fingerprint
  AND a.actor_id=d.created_by AND d.authorization_cap=g.authorization_cap AND g.created_by=a.actor_id
  AND ((a.action='CREATED' AND a.occurred_at=root.created_at AND l.request_id=b.request_id AND b.xmin::text=pg_current_xact_id()::xid::text)
   OR(a.action='ADMITTED' AND a.occurred_at=d.created_at AND a.after->>'admissionId'=d.id::text AND l.request_id=b.request_id AND b.xmin::text=pg_current_xact_id()::xid::text)
   OR(a.action='VERSION_ADDED' AND a.occurred_at=v.created_at AND a.after->>'versionId'=v.id::text AND l.request_id=p.request_id AND p.xmin::text=pg_current_xact_id()::xid::text)),false)
 FROM guest_hub_identity_document_admission b
 JOIN document_admission d ON(d.organization_id,d.id)=(b.organization_id,b.admission_id)
 JOIN document root ON(root.organization_id,root.id)=(b.organization_id,b.document_id)
 JOIN guest_hub_identity_document_file f ON(f.organization_id,f.id)=(b.organization_id,b.file_id)
 JOIN guest_hub_identity_document_capture c ON(c.organization_id,c.id)=(f.organization_id,f.capture_id)
 JOIN guest_hub_form_grant g ON(g.organization_id,g.id)=(c.organization_id,c.grant_id)
 LEFT JOIN guest_hub_identity_document_publication p ON(p.organization_id,p.file_id)=(b.organization_id,b.file_id)
 LEFT JOIN document_version v ON(v.organization_id,v.id)=(p.organization_id,p.version_id)
 WHERE b.organization_id=a.organization_id AND b.document_id=a.document_id
$$;

CREATE OR REPLACE FUNCTION app_document_action_required(organization_uuid uuid,document_uuid uuid,action_key text,actor_uuid uuid,at_time timestamptz,version_uuid uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM document_action a JOIN audit_log l ON l.organization_id=a.organization_id AND l.resource_id=a.id
    AND l.resource_type='document' AND l.action='documents.'||lower(action_key)
    WHERE a.organization_id=organization_uuid AND a.document_id=document_uuid AND a.action=action_key AND a.occurred_at=at_time
    AND (a.actor_id=actor_uuid AND NOT EXISTS(SELECT 1 FROM signature_signed_artifact asset WHERE asset.organization_id=organization_uuid AND asset.document_id=document_uuid) OR a.actor_id IS NULL AND app_signed_archive_action_valid(a) AND EXISTS(SELECT 1 FROM document root WHERE root.organization_id=organization_uuid AND root.id=document_uuid AND root.created_by=actor_uuid))
    AND (version_uuid IS NULL OR a.after->>(CASE WHEN action_key='ADMITTED' THEN 'admissionId' ELSE 'versionId' END)=version_uuid::text)
    AND ((NOT a.after ? 'guestIdentityOrigin' AND l.actor_id IS NOT DISTINCT FROM a.actor_id) OR app_guest_identity_archive_action_valid(a,l))
    AND l.occurred_at=a.occurred_at AND l.after->>'documentId'=a.document_id::text
    AND l.after->>'commandHash'=a.command_hash AND a.xmin::text=pg_current_xact_id()::xid::text AND l.xmin::text=a.xmin::text)
  THEN RAISE EXCEPTION 'document mutation requires atomic private history and canonical audit'; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_guard_document_action() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM signature_signed_artifact asset WHERE asset.organization_id=NEW.organization_id AND asset.document_id=NEW.document_id) AND NOT app_signed_archive_action_valid(NEW) THEN RAISE EXCEPTION 'signed artifact history requires its actual system attribution'; END IF;
  IF NEW.actor_id IS NULL AND NOT app_signed_archive_action_valid(NEW) THEN RAISE EXCEPTION 'system document action requires its actual retained signed artifact'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_id=NEW.id AND l.resource_type='document'
    AND l.action='documents.'||lower(NEW.action)
    AND ((NOT NEW.after ? 'guestIdentityOrigin' AND l.actor_id IS NOT DISTINCT FROM NEW.actor_id) OR app_guest_identity_archive_action_valid(NEW,l))
    AND l.occurred_at=NEW.occurred_at AND l.after->>'documentId'=NEW.document_id::text AND l.after->>'commandHash'=NEW.command_hash
    AND l.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'each private document action requires its own atomic canonical audit'; END IF; RETURN NULL;
END $$;

CREATE FUNCTION app_guest_identity_initial_retention_audit_valid(r document_retention_revision,l audit_log) RETURNS boolean LANGUAGE SQL STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(r.number=1 AND r.previous_id IS NULL AND l.actor_id IS NULL AND r.created_by=d.created_by AND r.authorization_cap=d.authorization_cap
  AND l.organization_id=r.organization_id AND l.resource_type='document' AND l.resource_id=b.document_id AND l.action='documents.retention_recorded'
  AND l.after->'guestIdentityOrigin'=app_guest_identity_document_origin(b.organization_id,b.file_id)
  AND l.property_scope_id=c.property_id AND l.request_id=p.request_id AND p.xmin::text=pg_current_xact_id()::xid::text,false)
 FROM guest_hub_identity_document_publication p
 JOIN guest_hub_identity_document_admission b ON(b.organization_id,b.file_id)=(p.organization_id,p.file_id)
 JOIN document_admission d ON(d.organization_id,d.id)=(b.organization_id,b.admission_id)
 JOIN guest_hub_identity_document_file f ON(f.organization_id,f.id)=(b.organization_id,b.file_id)
 JOIN guest_hub_identity_document_capture c ON(c.organization_id,c.id)=(f.organization_id,f.capture_id)
 WHERE p.organization_id=r.organization_id AND p.retention_revision_id=r.id AND p.version_id=r.version_id
$$;

-- Every original retention/version/policy/nonce check is retained.
CREATE OR REPLACE FUNCTION app_guard_document_retention_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original document_version%ROWTYPE; root document%ROWTYPE; admission document_admission%ROWTYPE;
  prior document_retention_revision%ROWTYPE; rule config_rule%ROWTYPE; captured jsonb; canonical text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':documents:retention:'||NEW.version_id::text,0));
  SELECT * INTO original FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.version_id;
  SELECT * INTO root FROM document WHERE organization_id=NEW.organization_id AND id=original.document_id;
  SELECT * INTO admission FROM document_admission WHERE organization_id=NEW.organization_id AND id=original.admission_id;
  SELECT * INTO prior FROM document_retention_revision WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id<>NEW.id ORDER BY number DESC LIMIT 1;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(NEW.policy_snapshot->>'id')::uuid;
  SELECT coalesce(array_agg(key ORDER BY key COLLATE "C"),ARRAY[]::text[]) INTO canonical FROM(SELECT DISTINCT unnest(NEW.tag_keys) AS key) s;
  IF rule.id IS NOT NULL THEN SELECT coalesce(jsonb_agg(value ORDER BY value->>'key' COLLATE "C"),'[]'::jsonb) INTO captured
    FROM jsonb_array_elements(rule.value->'tags') WHERE value->>'key'=ANY(NEW.tag_keys); END IF;
  IF original.id IS NULL OR root.id IS NULL OR admission.id IS NULL OR root.kind NOT IN('FILE','TEMPLATE','INSTANCE')
    OR EXISTS(SELECT 1 FROM signature_signed_artifact WHERE organization_id=NEW.organization_id AND document_id=root.id)
    OR (prior.id IS NULL AND (NEW.previous_id IS NOT NULL OR NEW.number<>1))
    OR (prior.id IS NOT NULL AND (NEW.previous_id IS DISTINCT FROM prior.id OR NEW.number<>prior.number+1 OR NEW.created_at<prior.created_at))
    OR NEW.authorization_cap->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
    OR NEW.authorization_cap->>'userAccountId' IS DISTINCT FROM NEW.created_by::text
    OR NEW.source_snapshot->>'documentId' IS DISTINCT FROM root.id::text
    OR NEW.source_snapshot->>'versionId' IS DISTINCT FROM original.id::text
    OR NEW.source_snapshot->>'versionSha256' IS DISTINCT FROM admission.sha256
    OR NOT coalesce(NEW.source_snapshot->'privacy' @> to_jsonb(root.privacy),false)
    OR NOT coalesce(NEW.source_snapshot->>'archiveFingerprint' ~ '^[a-f0-9]{64}$',false)
    OR NEW.input->>'protocol' IS DISTINCT FROM 'ALVILLAS_DOCUMENT_RETENTION_V1'
    OR NEW.input->>'versionId' IS DISTINCT FROM NEW.version_id::text
    OR NEW.input->>'previousRevisionId' IS DISTINCT FROM NEW.previous_id::text
    OR NEW.input->'tagKeys' IS DISTINCT FROM to_jsonb(NEW.tag_keys)
    OR NEW.input->>'idempotencyKey' IS DISTINCT FROM NEW.command_key::text OR NEW.input->>'reason' IS DISTINCT FROM NEW.reason
    OR NOT coalesce(NEW.input->>'reviewFingerprint' ~ '^[a-f0-9]{64}$',false)
    OR NEW.tag_keys IS DISTINCT FROM canonical OR NEW.tags IS DISTINCT FROM captured
    OR jsonb_array_length(NEW.tags)<>cardinality(NEW.tag_keys)
    OR rule.id IS NULL OR rule.key<>'documents.retention' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
    OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
    OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_DOCUMENT_VERSIONS'
    OR rule.value->>'artifact_inheritance' IS DISTINCT FROM 'ORIGINAL_SIGNED_VERSION'
    OR NOT coalesce(rule.value->>'archive_tagging' IN('ALLOW','DENY'),false)
    OR (root.archived_at IS NOT NULL AND rule.value->>'archive_tagging'<>'ALLOW')
    OR NOT coalesce(rule.value->'type_keys' ? root.type_key,false)
  THEN RAISE EXCEPTION 'document retention requires its actual version, previous immutable revision and configured tag snapshots'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='document' AND l.resource_id=root.id
    AND l.action='documents.retention_recorded' AND ((NOT l.after ? 'guestIdentityOrigin' AND l.actor_id=NEW.created_by) OR app_guest_identity_initial_retention_audit_valid(NEW,l)) AND l.occurred_at=NEW.created_at AND l.reason=NEW.reason
    AND l.after->>'revisionId'=NEW.id::text AND l.after->>'documentId'=root.id::text AND l.after->>'versionId'=NEW.version_id::text
    AND l.after->>'previousRevisionId' IS NOT DISTINCT FROM NEW.previous_id::text
    AND l.after->'tagKeys'=to_jsonb(NEW.tag_keys) AND l.after->>'number'=NEW.number::text
    AND l.after->>'commandHash'=NEW.command_hash AND l.after->>'sourceFingerprint'=NEW.source_fingerprint
    AND l.xmin::text=pg_current_xact_id()::xid::text AND NEW.xmin::text=l.xmin::text)
  THEN RAISE EXCEPTION 'document retention requires its atomic private actor audit'; END IF;
  RETURN NULL;
END $$;

COMMIT;
