CREATE TABLE lead_conversion (
 id UUID NOT NULL DEFAULT app_uuid_v7(), organization_id UUID NOT NULL, lead_id UUID NOT NULL,
 profile_revision_id UUID, signed_stage_id UUID NOT NULL, signed_archive_id UUID NOT NULL,
 owner_id UUID NOT NULL, mode TEXT NOT NULL, source_key TEXT NOT NULL, locale TEXT NOT NULL,
 created_by UUID NOT NULL, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 command_key UUID NOT NULL, command_hash TEXT NOT NULL, review_fingerprint TEXT NOT NULL,
 source_fingerprint TEXT NOT NULL, source_snapshot JSONB NOT NULL,
 payload_schema_version INTEGER NOT NULL DEFAULT 1, encrypted_payload BYTEA NOT NULL, payload_sha256 TEXT NOT NULL,
 policy_id UUID NOT NULL, policy_version INTEGER NOT NULL, policy_snapshot JSONB NOT NULL,
 authorization_cap JSONB NOT NULL, request_id TEXT NOT NULL,
 CONSTRAINT lead_conversion_pkey PRIMARY KEY(id),
 CONSTRAINT lead_conversion_org_fk FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT lead_conversion_lead_fk FOREIGN KEY(organization_id,lead_id) REFERENCES lead(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT lead_conversion_profile_fk FOREIGN KEY(organization_id,lead_id,profile_revision_id) REFERENCES lead_profile_revision(organization_id,lead_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT lead_conversion_signed_stage_fk FOREIGN KEY(organization_id,lead_id,signed_stage_id) REFERENCES lead_stage_revision(organization_id,lead_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT lead_conversion_signed_archive_fk FOREIGN KEY(organization_id,signed_archive_id) REFERENCES signature_signed_archive(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT lead_conversion_owner_fk FOREIGN KEY(organization_id,owner_id) REFERENCES owner(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT lead_conversion_author_fk FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT lead_conversion_policy_fk FOREIGN KEY(organization_id,policy_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX lead_conversion_org_id_key ON lead_conversion(organization_id,id);
CREATE UNIQUE INDEX lead_conversion_org_lead_key ON lead_conversion(organization_id,lead_id);
CREATE UNIQUE INDEX lead_conversion_org_command_key ON lead_conversion(organization_id,command_key);
CREATE INDEX lead_conversion_org_created_idx ON lead_conversion(organization_id,created_at,id);
CREATE INDEX lead_conversion_org_source_idx ON lead_conversion(organization_id,source_key,created_at,id);
CREATE INDEX lead_conversion_org_owner_idx ON lead_conversion(organization_id,owner_id,created_at,id);
ALTER TABLE lead_conversion ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_conversion FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_conversion_tenant_isolation ON lead_conversion
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER lead_conversion_immutable BEFORE UPDATE OR DELETE ON lead_conversion
 FOR EACH ROW EXECUTE FUNCTION app_lead_append_only();
ALTER TABLE lead_conversion ADD CONSTRAINT lead_conversion_shape CHECK(coalesce(
 mode IN('CREATE','LINK') AND locale IN('en','fr','ar') AND source_key ~ '^[a-z][a-z0-9_]{0,119}$'
 AND isfinite(created_at) AND payload_schema_version=1 AND octet_length(encrypted_payload) BETWEEN 64 AND 33024
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object'
 AND jsonb_typeof(authorization_cap)='object' AND length(request_id) BETWEEN 1 AND 1000,false));

CREATE FUNCTION app_guard_lead_conversion() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original lead%ROWTYPE; profile lead_profile_revision%ROWTYPE; stage lead_stage_revision%ROWTYPE; target owner%ROWTYPE; rule config_rule%ROWTYPE; owner_xmin text;
BEGIN
 SELECT * INTO original FROM lead WHERE organization_id=NEW.organization_id AND id=NEW.lead_id;
 SELECT * INTO profile FROM lead_profile_revision WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id ORDER BY number DESC LIMIT 1;
 SELECT * INTO stage FROM lead_stage_revision WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id ORDER BY number DESC LIMIT 1;
 IF original.id IS NULL OR NEW.created_at<original.created_at OR NEW.profile_revision_id IS DISTINCT FROM profile.id
  OR NEW.source_key IS DISTINCT FROM coalesce(profile.source_key,original.source_key)
  OR NEW.locale IS DISTINCT FROM coalesce(profile.locale,original.locale)
  OR stage.id IS DISTINCT FROM NEW.signed_stage_id OR stage.to_stage IS DISTINCT FROM 'SIGNED' OR NEW.created_at<stage.created_at
  OR NEW.source_snapshot->>'leadId' IS DISTINCT FROM original.id::text
  OR NEW.source_snapshot->>'capturePayloadSha256' IS DISTINCT FROM original.payload_sha256
  OR NEW.source_snapshot->>'profileRevisionId' IS DISTINCT FROM profile.id::text
  OR NEW.source_snapshot->>'profilePayloadSha256' IS DISTINCT FROM profile.payload_sha256
  OR NEW.source_snapshot->>'signedStageId' IS DISTINCT FROM stage.id::text
  OR NEW.source_snapshot->>'signedStageCommandHash' IS DISTINCT FROM stage.command_hash
  OR NEW.source_snapshot->>'signedArchiveId' IS DISTINCT FROM NEW.signed_archive_id::text
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(stage.evidence) proof(value)
    WHERE proof.value->>'kind'='SIGNATURE_SIGNED_ARCHIVE' AND proof.value->>'sourceId'=NEW.signed_archive_id::text)
 THEN RAISE EXCEPTION 'lead conversion requires its exact current profile and native signed stage'; END IF;
 SELECT * INTO target FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id;
 SELECT xmin::text INTO owner_xmin FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id;
 IF target.id IS NULL OR target.archived_at IS NOT NULL OR target.created_at>NEW.created_at
 THEN RAISE EXCEPTION 'lead conversion requires its actual active tenant owner'; END IF;
 IF NEW.mode='CREATE' AND (target.created_by IS DISTINCT FROM NEW.created_by OR owner_xmin IS DISTINCT FROM NEW.xmin::text
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
    AND a.action='owner.create' AND a.resource_type='owner' AND a.resource_id=target.id
    AND a.request_id=NEW.request_id AND a.xmin::text=NEW.xmin::text))
 THEN RAISE EXCEPTION 'lead conversion requires its atomic canonical owner creation'; END IF;
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
 IF rule.id IS NULL OR rule.created_by IS NULL OR rule.key<>'crm.lead_conversion' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
  OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED')
  OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
  OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
  OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_REVIEWED_LEAD_OWNER_CONVERSION'
  OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_ORIGINAL_CONVERSION'
  OR rule.value->>'prerequisite' IS DISTINCT FROM 'NATIVE_SIGNED_STAGE_AND_COMPLETED_ARCHIVE'
  OR NOT coalesce(rule.value->'modes' ? NEW.mode,false)
 THEN RAISE EXCEPTION 'lead conversion requires its actual approved organization policy'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by
  AND a.action='crm.lead_converted' AND a.resource_type='lead' AND a.resource_id=NEW.lead_id AND a.request_id=NEW.request_id
  AND a.occurred_at=NEW.created_at AND a.xmin::text=NEW.xmin::text AND a.xmin::text=pg_current_xact_id()::xid::text
  AND a.after=jsonb_build_object('leadId',NEW.lead_id,'conversionId',NEW.id,'ownerId',NEW.owner_id,'mode',NEW.mode,
    'profileRevisionId',NEW.profile_revision_id,'signedStageId',NEW.signed_stage_id,'signedArchiveId',NEW.signed_archive_id,
    'sourceKey',NEW.source_key,'commandHash',NEW.command_hash,'payloadSha256',NEW.payload_sha256,
    'sourceFingerprint',NEW.source_fingerprint,'reviewFingerprint',NEW.review_fingerprint,'policyId',NEW.policy_id))
 THEN RAISE EXCEPTION 'lead conversion requires its atomic private actor audit'; END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='crm.lead_converted'
  AND e.idempotency_key='crm.lead.converted:'||NEW.id::text AND e.occurred_at=NEW.created_at AND e.xmin::text=NEW.xmin::text
  AND e.payload=jsonb_build_object('leadId',NEW.lead_id,'conversionId',NEW.id,'ownerId',NEW.owner_id,'mode',NEW.mode))
 THEN RAISE EXCEPTION 'lead conversion requires its atomic identifier-only outbox event'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER lead_conversion_guard AFTER INSERT ON lead_conversion
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_lead_conversion();
