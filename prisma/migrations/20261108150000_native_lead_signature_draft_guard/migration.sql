BEGIN;

-- Forward-only: retain all original draft/provider/archive assertions and business rows.
CREATE OR REPLACE FUNCTION app_guard_native_signature_draft() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature%ROWTYPE; instance document_instance%ROWTYPE; version document_version%ROWTYPE;
  admission document_admission%ROWTYPE; root document%ROWTYPE; rule config_rule%ROWTYPE; lead_rule config_rule%ROWTYPE;
  snapshot jsonb; command jsonb; captured jsonb; recipient signature_recipient%ROWTYPE; identity jsonb;
  expected jsonb; reference jsonb; actual_reference jsonb; recipient_count integer; boundary integer;
BEGIN
  IF TG_TABLE_NAME='signature' THEN original:=NEW;
  ELSE SELECT * INTO original FROM signature WHERE organization_id=NEW.organization_id AND id=NEW.signature_id; END IF;
  snapshot:=original.policy_snapshot;
  IF snapshot->>'protocol' IS DISTINCT FROM 'ALVILLAS_NATIVE_SIGNATURE_REQUEST_V1' THEN RETURN NULL; END IF;
  command:=snapshot->'command'; captured:=snapshot->'document';
  SELECT * INTO instance FROM document_instance WHERE organization_id=original.organization_id AND id=original.instance_id;
  SELECT * INTO version FROM document_version WHERE organization_id=original.organization_id AND id=original.document_version_id;
  SELECT * INTO admission FROM document_admission WHERE organization_id=original.organization_id AND id=version.admission_id;
  SELECT * INTO root FROM document WHERE organization_id=original.organization_id AND id=instance.document_id;
  SELECT * INTO rule FROM config_rule WHERE organization_id=original.organization_id AND id=(snapshot->'archivePolicy'->>'id')::uuid;
  IF NOT coalesce(snapshot->>'schemaVersion'='1' AND jsonb_typeof(command)='object' AND jsonb_typeof(captured)='object'
    AND snapshot->>'commandHash'=original.command_hash AND snapshot->>'nativeSourceFingerprint'=original.source_fingerprint
    AND snapshot->>'archiveFingerprint' ~ '^[a-f0-9]{64}$'
    AND command->>'instanceId'=original.instance_id::text AND command->>'documentVersionId'=original.document_version_id::text
    AND command->>'idempotencyKey'=original.command_key::text AND command->>'reason'=original.reason
    AND command->>'reviewFingerprint' ~ '^[a-f0-9]{64}$'
    AND original.authorization_cap->>'schemaVersion'='1' AND original.authorization_cap->>'organizationId'=original.organization_id::text
    AND original.authorization_cap->>'userAccountId'=original.requested_by::text
    AND instance.id IS NOT NULL AND version.id IS NOT NULL AND root.id IS NOT NULL
    AND app_document_version_matches_instance(original.organization_id,version.id,instance.id)
    AND admission.content_type='application/pdf' AND admission.input->>'generationInstanceId'=instance.id::text
    AND captured->>'id'=root.id::text AND captured->>'instanceId'=instance.id::text AND captured->>'versionId'=version.id::text
    AND captured->>'admissionId'=admission.id::text AND captured->>'sha256'=admission.sha256
    AND captured->>'byteSize'=admission.file_size::text AND captured->>'locale'=root.locale
    AND captured->'source'=jsonb_build_object('kind',root.source_kind,'id',root.source_id)
    AND rule.id IS NOT NULL AND rule.key='documents.archive' AND snapshot->'archivePolicy'->'value'=rule.value
    AND snapshot->'archivePolicy'->>'version'=rule.version::text
    AND jsonb_typeof(snapshot->'recipients')='array' AND jsonb_typeof(command->'recipients')='array',false)
  THEN RAISE EXCEPTION 'native signature draft requires its exact archived instance and captured policy'; END IF;
  -- A Lead contract retains its approved native policy and its actual owning signer.
  -- Resolve the original immutable rule, preserving history after later retirement.
  IF root.source_kind='LEAD' THEN
    SELECT * INTO lead_rule FROM config_rule WHERE organization_id=original.organization_id
      AND id=(snapshot->'leadContractPolicy'->>'id')::uuid;
    IF NOT coalesce(lead_rule.id IS NOT NULL AND lead_rule.created_by IS NOT NULL
      AND lead_rule.key='crm.pipeline' AND lead_rule.scope_type='organization' AND lead_rule.scope_id IS NULL
      AND snapshot->'leadContractPolicy'=jsonb_build_object('id',lead_rule.id,'version',lead_rule.version,
        'contractTypeKeys',lead_rule.value->'document_types'->'contract')
      AND lead_rule.value->'document_types'->'contract' @> jsonb_build_array(root.type_key)
      AND (SELECT count(*) FROM jsonb_array_elements(command->'recipients') r
        WHERE r=jsonb_build_object('kind','LEAD','id',root.source_id))=1
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(command->'recipients') r
        WHERE r->>'kind'='LEAD' AND r->>'id' IS DISTINCT FROM root.source_id::text),false)
    THEN RAISE EXCEPTION 'native lead signature requires its approved contract policy and owning signer'; END IF;
  ELSIF snapshot ? 'leadContractPolicy' OR EXISTS(SELECT 1 FROM jsonb_array_elements(command->'recipients') r WHERE r->>'kind'='LEAD')
  THEN RAISE EXCEPTION 'native lead signer requires its actual lead contract source'; END IF;
  recipient_count:=jsonb_array_length(snapshot->'recipients');
  IF recipient_count NOT BETWEEN 1 AND 100 OR recipient_count<>jsonb_array_length(command->'recipients')
    OR recipient_count<>(SELECT count(*) FROM signature_recipient WHERE organization_id=original.organization_id AND signature_id=original.id)
  THEN RAISE EXCEPTION 'native signature draft requires its exact captured recipients'; END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements(snapshot->'recipients') LOOP
    reference:=expected->'reference';
    IF NOT coalesce(reference->>'kind' IN ('PERSON','OWNER','GUEST','SUPPLIER','LEAD') AND expected->>'fingerprint' ~ '^[a-f0-9]{64}$'
      AND expected->>'identityHash'=encode(digest('{"kind":'||to_json(reference->>'kind')::text||',"id":'||to_json(reference->>'id')::text||'}','sha256'),'hex')
      AND (SELECT count(*) FROM jsonb_array_elements(command->'recipients') r WHERE r=reference)=1
      AND (SELECT count(*) FROM jsonb_array_elements(snapshot->'recipients') r WHERE r->'reference'=reference)=1,false)
    THEN RAISE EXCEPTION 'native signature draft recipient identity cannot be substituted'; END IF;
    SELECT * INTO recipient FROM signature_recipient WHERE organization_id=original.organization_id AND signature_id=original.id AND identity_hash=expected->>'identityHash';
    identity:=jsonb_build_object('organizationId',original.organization_id,'signatureId',original.id,'recipientId',recipient.id,'reference',reference,'fingerprint',expected->>'fingerprint');
    actual_reference:=CASE WHEN recipient.person_id IS NOT NULL THEN jsonb_build_object('kind','PERSON','id',recipient.person_id)
      WHEN recipient.owner_id IS NOT NULL THEN jsonb_build_object('kind','OWNER','id',recipient.owner_id)
      WHEN recipient.guest_id IS NOT NULL THEN jsonb_build_object('kind','GUEST','id',recipient.guest_id)
      WHEN recipient.lead_id IS NOT NULL THEN jsonb_build_object('kind','LEAD','id',recipient.lead_id)
      ELSE jsonb_build_object('kind','SUPPLIER','id',recipient.supplier_id) END;
    boundary:=position(decode('0a','hex') in recipient.email_cipher);
    IF NOT coalesce(recipient.id IS NOT NULL AND actual_reference=reference AND recipient.created_at=original.requested_at
      AND recipient.source_snapshot=jsonb_build_object('protocol','ALVILLAS_NATIVE_SIGNATURE_RECIPIENT_V1','schemaVersion',1,'identity',identity)
      AND boundary BETWEEN 1 AND 256 AND octet_length(recipient.email_cipher)>boundary AND octet_length(recipient.email_cipher)<=8448
      AND convert_from(substring(recipient.email_cipher FROM 1 FOR greatest(boundary-1,0)),'UTF8') ~ '^alvillas-binary-v1:[^:]{1,180}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}$',false)
    THEN RAISE EXCEPTION 'native signature draft requires identity-bound encrypted recipient evidence'; END IF;
  END LOOP;
  -- Provider and archival transitions require their own durable evidence protocol. A recipient
  -- event, an unverified webhook, or an arbitrary provider ID cannot turn this draft into SIGNED.
  IF (SELECT count(*) FROM signature_event WHERE organization_id=original.organization_id AND signature_id=original.id AND state='DRAFT')<>1
    OR EXISTS(SELECT 1 FROM signature_event e WHERE e.organization_id=original.organization_id AND e.signature_id=original.id AND e.state='DRAFT' AND e.provider_evidence_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM signature_event e WHERE e.organization_id=original.organization_id AND e.signature_id=original.id AND e.state<>'DRAFT' AND NOT(app_native_signature_distribution_event_valid(e) OR app_native_signature_webhook_event_valid(e) OR app_native_signed_archive_event_valid(e)))
    OR NOT EXISTS(SELECT 1 FROM signature_event WHERE organization_id=original.organization_id AND signature_id=original.id
      AND state='DRAFT' AND evidence_hash=original.command_hash AND occurred_at=original.requested_at AND observed_at=original.requested_at)
  THEN RAISE EXCEPTION 'native signature transition requires its durable provider and archive protocol'; END IF;
  IF TG_TABLE_NAME='signature' THEN
    IF NOT EXISTS(SELECT 1 FROM document_action a WHERE a.organization_id=original.organization_id AND a.document_id=root.id
      AND a.action='SIGNATURE_CREATED' AND a.actor_id=original.requested_by AND a.occurred_at=original.requested_at
      AND a.command_key=original.command_key AND a.command_hash=original.command_hash AND a.reason=original.reason
      AND a.source_fingerprint=original.source_fingerprint AND a.before='{}'::jsonb
      AND a.after=jsonb_build_object('signatureId',original.id,'instanceId',instance.id,'versionId',version.id,'recipientCount',recipient_count)
      AND a.xmin::text=pg_current_xact_id()::xid::text)
      OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=original.organization_id AND e.type='documents.signature.draft_created'
        AND e.payload=jsonb_build_object('signatureId',original.id)
        AND e.idempotency_key='document-signature-draft:'||original.requested_by::text||':'||original.command_key::text
        AND e.occurred_at=original.requested_at AND e.xmin::text=pg_current_xact_id()::xid::text)
      OR EXISTS(SELECT 1 FROM document_admission WHERE organization_id=original.organization_id AND created_by=original.requested_by AND command_key=original.command_key)
      OR EXISTS(SELECT 1 FROM document_instance WHERE organization_id=original.organization_id AND created_by=original.requested_by AND command_key=original.command_key)
    THEN RAISE EXCEPTION 'native signature draft requires atomic private history and reference-only outbox'; END IF;
    PERFORM app_document_action_required(original.organization_id,root.id,'SIGNATURE_CREATED',original.requested_by,original.requested_at);
  END IF;
  RETURN NULL;
END $$;


COMMIT;
