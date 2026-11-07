BEGIN;

-- AlterTable
ALTER TABLE "signature_event" ADD COLUMN     "provider_evidence_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "signature_event_provider_evidence_unique" ON "signature_event"("organization_id", "provider_evidence_id");

-- AddForeignKey
ALTER TABLE "signature_event" ADD CONSTRAINT "signature_event_organization_id_provider_evidence_id_fkey" FOREIGN KEY ("organization_id", "provider_evidence_id") REFERENCES "signature_provider_evidence"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;



ALTER TABLE signature_provider_intent DROP CONSTRAINT signature_provider_intent_shape;
ALTER TABLE signature_provider_intent ADD CONSTRAINT signature_provider_intent_shape CHECK (
  phase IN('PREPARE','SEND') AND command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND provider_scope_hash ~ '^[a-f0-9]{64}$' AND length(reason) BETWEEN 8 AND 1000
  AND octet_length(canonical_request) BETWEEN 1 AND 1064960
  AND jsonb_typeof(input)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object');

ALTER TABLE signature_provider_attempt DROP CONSTRAINT signature_provider_attempt_shape;
ALTER TABLE signature_provider_attempt ADD CONSTRAINT signature_provider_attempt_shape CHECK(phase IN('PREPARE','SEND'));

ALTER TABLE signature_provider_evidence DROP CONSTRAINT signature_provider_evidence_shape;
ALTER TABLE signature_provider_evidence ADD CONSTRAINT signature_provider_evidence_shape CHECK (coalesce(
  phase IN('PREPARE','SEND') AND kind IN('PREPARED','SENT','UNCERTAIN') AND provider_scope_hash ~ '^[a-f0-9]{64}$'
  AND original_pdf_sha256 ~ '^[a-f0-9]{64}$' AND contract_hash ~ '^[a-f0-9]{64}$' AND observation_hash ~ '^[a-f0-9]{64}$' AND payload_sha256 ~ '^[a-f0-9]{64}$'
  AND payload_byte_size BETWEEN 1 AND 4194304 AND octet_length(payload_cipher)>payload_byte_size AND octet_length(payload_cipher)<=payload_byte_size+256
  AND (provider_request_id IS NULL OR provider_request_id ~ '^[A-Za-z0-9_-]{1,255}$')
  AND ((kind='PREPARED' AND phase='PREPARE' AND provider_request_id IS NOT NULL AND provider_state='DRAFT') OR (kind='SENT' AND phase='SEND' AND provider_request_id IS NOT NULL AND provider_state IN('PENDING','COMPLETED')) OR (kind='UNCERTAIN' AND provider_state IS NULL)),false));

CREATE UNIQUE INDEX signature_provider_sent_native_unique ON signature_provider_evidence(organization_id,signature_id,phase) WHERE kind='SENT';

CREATE UNIQUE INDEX signature_provider_sent_external_unique ON signature_provider_evidence(provider_scope_hash,provider_request_id) WHERE kind='SENT';

CREATE FUNCTION app_assert_signature_distribution_intent(original signature_provider_intent) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE prepared signature_provider_intent%ROWTYPE; attempt signature_provider_attempt%ROWTYPE;
  evidence signature_provider_evidence%ROWTYPE; native signature%ROWTYPE; snapshot jsonb; command jsonb;
BEGIN
  snapshot:=original.policy_snapshot; command:=original.input;
  SELECT * INTO prepared FROM signature_provider_intent WHERE organization_id=original.organization_id AND id=(command->>'preparationId')::uuid AND phase='PREPARE';
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=original.organization_id AND signature_id=original.signature_id AND phase='PREPARE';
  SELECT * INTO evidence FROM signature_provider_evidence WHERE organization_id=original.organization_id AND attempt_id=attempt.id AND kind='PREPARED';
  SELECT * INTO native FROM signature WHERE organization_id=original.organization_id AND id=original.signature_id;
  IF NOT coalesce(original.phase='SEND' AND snapshot->>'protocol'='ALVILLAS_SIGNATURE_DISTRIBUTION_V1' AND snapshot->>'schemaVersion'='1'
    AND snapshot->'command'=command AND snapshot->>'commandHash'=original.command_hash
    AND encode(digest(original.canonical_request,'sha256'),'hex')=original.command_hash
    AND original.canonical_request::jsonb=jsonb_build_object('organizationId',original.organization_id,'actorId',original.requested_by,'input',command)
    AND command->>'delivery'='EMAIL' AND command->>'idempotencyKey'=original.command_key::text AND command->>'reviewFingerprint' ~ '^[a-f0-9]{64}$' AND command->>'reason'=original.reason
    AND original.authorization_cap->>'schemaVersion'='1' AND original.authorization_cap->>'organizationId'=original.organization_id::text
    AND original.authorization_cap->>'userAccountId'=original.requested_by::text AND original.authorization_cap->'permissions' ? 'signature:edit'
    AND prepared.id IS NOT NULL AND attempt.id IS NOT NULL AND evidence.id IS NOT NULL AND native.id IS NOT NULL
    AND prepared.signature_id=original.signature_id AND attempt.intent_id=prepared.id AND attempt.signature_id=original.signature_id
    AND evidence.signature_id=original.signature_id AND evidence.phase='PREPARE' AND evidence.provider_state='DRAFT'
    AND snapshot->>'signatureId'=native.id::text AND snapshot->>'signatureCommandHash'=native.command_hash
    AND snapshot->>'contextFingerprint' ~ '^[a-f0-9]{64}$' AND snapshot->>'contractHash'=evidence.contract_hash
    AND original.provider_scope_hash=prepared.provider_scope_hash AND evidence.provider_scope_hash=prepared.provider_scope_hash
    AND original.source_fingerprint=prepared.source_fingerprint AND original.source_fingerprint=native.source_fingerprint
    AND snapshot->'document'=prepared.policy_snapshot->'document' AND snapshot->'providerPolicy'=prepared.policy_snapshot->'providerPolicy'
    AND snapshot->>'providerScopeHash'=prepared.provider_scope_hash AND snapshot->'recipients'=prepared.policy_snapshot->'recipients'
    AND snapshot->'preparation'=jsonb_build_object('intentId',prepared.id,'attemptId',attempt.id,'evidenceId',evidence.id,'commandHash',prepared.command_hash,'providerRequestId',evidence.provider_request_id)
    AND original.requested_at>=evidence.observed_at,false)
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(command) k WHERE k NOT IN('preparationId','delivery','idempotencyKey','reviewFingerprint','reason'))
  THEN RAISE EXCEPTION 'native distribution requires its exact prepared original, explicit email command and independently captured edit capability'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=original.organization_id AND a.actor_id=original.requested_by AND a.resource_type='signature' AND a.resource_id=original.id
      AND a.action='documents.signature.distribution_requested' AND a.occurred_at=original.requested_at
      AND a.after=jsonb_build_object('signatureId',original.signature_id,'intentId',original.id,'preparationId',prepared.id,'commandHash',original.command_hash,'contractHash',snapshot->>'contractHash')
      AND a.xmin::text=pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=original.organization_id AND e.type='documents.signature.distribute_requested' AND e.payload=jsonb_build_object('intentId',original.id)
      AND e.idempotency_key='document-signature-send:'||original.requested_by::text||':'||original.command_key::text AND e.occurred_at=original.requested_at AND e.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native distribution requires atomic private intent audit and reference-only outbox'; END IF;
END $$;

CREATE FUNCTION app_guard_signature_distribution_outbox() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.type='documents.signature.distribute_requested' OR OLD.idempotency_key LIKE 'document-signature-send:%' THEN RAISE EXCEPTION 'native distribution references are append-only'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (OLD.type='documents.signature.distribute_requested' OR OLD.idempotency_key LIKE 'document-signature-send:%')
      AND (NEW.organization_id,NEW.id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at)
    THEN RAISE EXCEPTION 'native distribution reference identity is immutable'; END IF;
  END IF;
  IF NEW.type='documents.signature.distribute_requested' OR NEW.idempotency_key LIKE 'document-signature-send:%' THEN
    IF NOT EXISTS(SELECT 1 FROM signature_provider_intent i WHERE i.organization_id=NEW.organization_id AND i.phase='SEND'
      AND NEW.type='documents.signature.distribute_requested' AND NEW.payload=jsonb_build_object('intentId',i.id)
      AND NEW.idempotency_key='document-signature-send:'||i.requested_by::text||':'||i.command_key::text AND NEW.occurred_at=i.requested_at)
    THEN RAISE EXCEPTION 'native distribution requires its exact original outbox reference'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_distribution_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_signature_distribution_outbox();

CREATE FUNCTION app_native_signature_distribution_event_valid(event signature_event) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(event.state='SENT' AND event.signed_version_id IS NULL AND EXISTS(
    SELECT 1 FROM signature_provider_evidence e JOIN signature_provider_attempt a ON a.organization_id=e.organization_id AND a.id=e.attempt_id
      JOIN signature_provider_intent i ON i.organization_id=a.organization_id AND i.id=a.intent_id
    WHERE e.organization_id=event.organization_id AND e.id=event.provider_evidence_id AND e.signature_id=event.signature_id
      AND e.kind='SENT' AND e.phase='SEND' AND a.phase='SEND' AND i.phase='SEND'
      AND i.policy_snapshot->>'protocol'='ALVILLAS_SIGNATURE_DISTRIBUTION_V1' AND e.provider_request_id=i.policy_snapshot->'preparation'->>'providerRequestId'
      AND event.provider_identity_hash=e.provider_scope_hash AND event.provider_request_id=e.provider_request_id
      AND event.provider_event_id='native-distribution:'||e.id::text AND event.evidence_hash=e.payload_sha256 AND event.evidence_cipher=e.payload_cipher
      AND event.occurred_at=e.observed_at AND event.observed_at=e.observed_at
      AND EXISTS(SELECT 1 FROM audit_log audit WHERE audit.organization_id=event.organization_id AND audit.actor_id IS NULL AND audit.resource_type='signature' AND audit.resource_id=event.signature_id
        AND audit.action='documents.signature.sent' AND audit.occurred_at=event.observed_at AND audit.xmin=(SELECT actual_event.xmin FROM signature_event actual_event WHERE actual_event.organization_id=event.organization_id AND actual_event.id=event.id)
        AND audit.after=jsonb_build_object('signatureId',event.signature_id,'intentId',i.id,'attemptId',a.id,'evidenceId',e.id,'signatureEventId',event.id))
  ),false)
$$;

CREATE FUNCTION app_guard_signature_distribution_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature_provider_intent%ROWTYPE; attempt signature_provider_attempt%ROWTYPE; history signature_event%ROWTYPE;
BEGIN
  IF NEW.kind<>'SENT' THEN RETURN NULL; END IF;
  SELECT * INTO attempt FROM signature_provider_attempt WHERE organization_id=NEW.organization_id AND id=NEW.attempt_id;
  SELECT * INTO original FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND id=attempt.intent_id;
  SELECT * INTO history FROM signature_event WHERE organization_id=NEW.organization_id AND provider_evidence_id=NEW.id;
  IF NOT coalesce(NEW.phase='SEND' AND original.phase='SEND' AND original.policy_snapshot->>'protocol'='ALVILLAS_SIGNATURE_DISTRIBUTION_V1'
    AND NEW.provider_request_id=original.policy_snapshot->'preparation'->>'providerRequestId'
    AND NEW.provider_state IN('PENDING','COMPLETED') AND history.id IS NOT NULL
    AND EXISTS(SELECT 1 FROM signature_event actual_event WHERE actual_event.organization_id=NEW.organization_id AND actual_event.id=history.id AND actual_event.xmin::text=pg_current_xact_id()::xid::text)
    AND app_native_signature_distribution_event_valid(history),false)
  THEN RAISE EXCEPTION 'native sent evidence requires its prepared provider identity and atomic audited signature history'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_distribution_evidence_guard AFTER INSERT ON signature_provider_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_signature_distribution_evidence();


CREATE OR REPLACE FUNCTION app_guard_signature_provider_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature%ROWTYPE; rule config_rule%ROWTYPE; root document%ROWTYPE; snapshot jsonb; layout jsonb; native jsonb; field jsonb; item jsonb;
  scope signature_provider_scope%ROWTYPE; ordinal bigint; recipients integer;
BEGIN
  IF NEW.phase='SEND' THEN PERFORM app_assert_signature_distribution_intent(NEW); RETURN NULL; END IF;
  snapshot:=NEW.policy_snapshot;
  SELECT * INTO original FROM signature WHERE organization_id=NEW.organization_id AND id=NEW.signature_id;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(snapshot->'providerPolicy'->>'id')::uuid;
  SELECT d.* INTO root FROM document d JOIN document_instance i ON i.organization_id=d.organization_id AND i.document_id=d.id WHERE i.organization_id=NEW.organization_id AND i.id=original.instance_id;
  SELECT * INTO scope FROM signature_provider_scope WHERE organization_id=NEW.organization_id AND scope_hash=NEW.provider_scope_hash;
  IF NOT coalesce(original.policy_snapshot->>'protocol'='ALVILLAS_NATIVE_SIGNATURE_REQUEST_V1' AND root.id IS NOT NULL AND root.archived_at IS NULL
    AND snapshot->>'protocol'='ALVILLAS_SIGNATURE_PREPARATION_V1' AND snapshot->>'schemaVersion'='1' AND snapshot->'command'=NEW.input
    AND snapshot->>'commandHash'=NEW.command_hash AND snapshot->>'signatureCommandHash'=original.command_hash
    AND snapshot->>'contextFingerprint' ~ '^[a-f0-9]{64}$' AND snapshot->>'contractHash' ~ '^[a-f0-9]{64}$'
    AND NEW.source_fingerprint=original.source_fingerprint AND snapshot->'document'=original.policy_snapshot->'document'
    AND NEW.input->>'signatureId'=NEW.signature_id::text AND NEW.input->>'idempotencyKey'=NEW.command_key::text AND NEW.input->>'reason'=NEW.reason
    AND NEW.input->>'reviewFingerprint' ~ '^[a-f0-9]{64}$'
    AND NEW.canonical_request::jsonb=jsonb_build_object('organizationId',NEW.organization_id,'actorId',NEW.requested_by,'input',NEW.input)
    AND encode(digest(NEW.canonical_request,'sha256'),'hex')=NEW.command_hash
    AND NEW.authorization_cap->>'schemaVersion'='1' AND NEW.authorization_cap->>'organizationId'=NEW.organization_id::text AND NEW.authorization_cap->>'userAccountId'=NEW.requested_by::text
    AND NEW.authorization_cap->'permissions' ?& ARRAY['signature:view','signature:create','document:export','document_instance:export']
    AND scope.scope_hash IS NOT NULL AND snapshot->>'providerScopeHash'=NEW.provider_scope_hash
    AND rule.id IS NOT NULL AND rule.key='documents.signatures' AND rule.version::text=snapshot->'providerPolicy'->>'version'
    AND snapshot->'providerPolicy'->'originalValue'=rule.value
    AND snapshot->'providerPolicy'->'value'=jsonb_set(rule.value,'{account,origin}',to_jsonb(regexp_replace(rule.value->'account'->>'origin','/$','')))
    AND rule.value->'enabled'='true'::jsonb AND rule.value->>'provider'='DOCUMENSO' AND rule.value->>'source'='NATIVE_DOCUMENT_SIGNATURES'
    AND scope.origin=snapshot->'providerPolicy'->'value'->'account'->>'origin' AND scope.team_id::text=snapshot->'providerPolicy'->'value'->'account'->>'teamId'
    AND jsonb_typeof(NEW.input->'recipients')='array' AND jsonb_typeof(snapshot->'recipients')='array',false)
  THEN RAISE EXCEPTION 'native preparation requires its original signature, actor, archived PDF and actual policy'; END IF;
  recipients:=jsonb_array_length(NEW.input->'recipients');
  IF recipients NOT BETWEEN 1 AND 100 OR recipients<>(SELECT count(*) FROM signature_recipient WHERE organization_id=NEW.organization_id AND signature_id=NEW.signature_id)
    OR recipients<>jsonb_array_length(snapshot->'recipients') OR (SELECT count(DISTINCT value->>'recipientId') FROM jsonb_array_elements(NEW.input->'recipients'))<>recipients
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.input) k WHERE k NOT IN('signatureId','recipients','idempotencyKey','reviewFingerprint','reason'))
  THEN RAISE EXCEPTION 'native preparation requires every original native recipient and bounded command'; END IF;
  FOR layout,ordinal IN SELECT value, ordinality FROM jsonb_array_elements(NEW.input->'recipients') WITH ORDINALITY LOOP
    item:=snapshot->'recipients'->(ordinal::integer-1);
    SELECT source_snapshot->'identity' INTO native FROM signature_recipient WHERE organization_id=NEW.organization_id AND signature_id=NEW.signature_id AND id=(layout->>'recipientId')::uuid;
    IF NOT coalesce(native IS NOT NULL AND item->>'id'=layout->>'recipientId' AND item->>'fingerprint'=native->>'fingerprint'
      AND item->>'identityHash'=(SELECT identity_hash FROM signature_recipient WHERE organization_id=NEW.organization_id AND id=(layout->>'recipientId')::uuid)
      AND layout->>'role' IN('SIGNER','APPROVER','VIEWER','CC','ASSISTANT') AND jsonb_typeof(layout->'fields')='array'
      AND jsonb_array_length(layout->'fields')<=200 AND jsonb_typeof(layout->'signingOrder')='number' AND (layout->>'signingOrder')::numeric>=0
      AND trunc((layout->>'signingOrder')::numeric)=(layout->>'signingOrder')::numeric,false)
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(layout) k WHERE k NOT IN('recipientId','role','signingOrder','fields'))
    THEN RAISE EXCEPTION 'native preparation layout cannot substitute an actual captured recipient'; END IF;
    IF layout->>'role'='SIGNER' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(layout->'fields') f WHERE f->>'type'='SIGNATURE')
    THEN RAISE EXCEPTION 'native signer requires an explicit signature field'; END IF;
    FOR field IN SELECT value FROM jsonb_array_elements(layout->'fields') LOOP
      IF NOT coalesce(field->>'type' IN('SIGNATURE','INITIALS','NAME','EMAIL','DATE') AND jsonb_typeof(field->'page')='number' AND (field->>'page')::numeric>=1 AND trunc((field->>'page')::numeric)=(field->>'page')::numeric
        AND jsonb_typeof(field->'positionX')='number' AND jsonb_typeof(field->'positionY')='number' AND jsonb_typeof(field->'width')='number' AND jsonb_typeof(field->'height')='number'
        AND (field->>'positionX')::numeric>=0 AND (field->>'positionY')::numeric>=0 AND (field->>'width')::numeric>0 AND (field->>'height')::numeric>0
        AND (field->>'positionX')::numeric+(field->>'width')::numeric<=100 AND (field->>'positionY')::numeric+(field->>'height')::numeric<=100,false)
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(field) k WHERE k NOT IN('type','page','positionX','positionY','width','height'))
      THEN RAISE EXCEPTION 'native preparation requires explicit bounded PDF field geometry'; END IF;
    END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'recipients') r WHERE r->>'role'='SIGNER')
    OR (SELECT coalesce(sum(jsonb_array_length(r->'fields')),0) FROM jsonb_array_elements(NEW.input->'recipients') r)>10000
  THEN RAISE EXCEPTION 'native preparation requires its actual signing contract'; END IF;
  IF snapshot->'providerPolicy'->'value'->'signing'->>'order'='SEQUENTIAL' AND (
    EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'recipients') r WHERE r->>'role' IN('SIGNER','APPROVER') AND (r->>'signingOrder')::numeric<1)
    OR (SELECT count(*) FROM jsonb_array_elements(NEW.input->'recipients') r WHERE r->>'role' IN('SIGNER','APPROVER'))
      <>(SELECT count(DISTINCT r->>'signingOrder') FROM jsonb_array_elements(NEW.input->'recipients') r WHERE r->>'role' IN('SIGNER','APPROVER')))
  THEN RAISE EXCEPTION 'sequential native recipients require explicit distinct signing positions'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.requested_by AND a.resource_type='signature' AND a.resource_id=NEW.id
    AND a.action='documents.signature.preparation_requested' AND a.occurred_at=NEW.requested_at
    AND a.after=jsonb_build_object('signatureId',NEW.signature_id,'intentId',NEW.id,'commandHash',NEW.command_hash,'contractHash',snapshot->>'contractHash')
    AND a.xmin::text=pg_current_xact_id()::xid::text)
    OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='documents.signature.prepare_requested' AND e.payload=jsonb_build_object('intentId',NEW.id)
      AND e.idempotency_key='document-signature-prepare:'||NEW.requested_by::text||':'||NEW.command_key::text AND e.occurred_at=NEW.requested_at AND e.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'native preparation requires atomic private intent audit and reference-only outbox'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app_guard_native_signature_draft() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original signature%ROWTYPE; instance document_instance%ROWTYPE; version document_version%ROWTYPE;
  admission document_admission%ROWTYPE; root document%ROWTYPE; rule config_rule%ROWTYPE;
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
  recipient_count:=jsonb_array_length(snapshot->'recipients');
  IF recipient_count NOT BETWEEN 1 AND 100 OR recipient_count<>jsonb_array_length(command->'recipients')
    OR recipient_count<>(SELECT count(*) FROM signature_recipient WHERE organization_id=original.organization_id AND signature_id=original.id)
  THEN RAISE EXCEPTION 'native signature draft requires its exact captured recipients'; END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements(snapshot->'recipients') LOOP
    reference:=expected->'reference';
    IF NOT coalesce(reference->>'kind' IN ('PERSON','OWNER','GUEST','SUPPLIER') AND expected->>'fingerprint' ~ '^[a-f0-9]{64}$'
      AND expected->>'identityHash'=encode(digest('{"kind":'||to_json(reference->>'kind')::text||',"id":'||to_json(reference->>'id')::text||'}','sha256'),'hex')
      AND (SELECT count(*) FROM jsonb_array_elements(command->'recipients') r WHERE r=reference)=1
      AND (SELECT count(*) FROM jsonb_array_elements(snapshot->'recipients') r WHERE r->'reference'=reference)=1,false)
    THEN RAISE EXCEPTION 'native signature draft recipient identity cannot be substituted'; END IF;
    SELECT * INTO recipient FROM signature_recipient WHERE organization_id=original.organization_id AND signature_id=original.id AND identity_hash=expected->>'identityHash';
    identity:=jsonb_build_object('organizationId',original.organization_id,'signatureId',original.id,'recipientId',recipient.id,'reference',reference,'fingerprint',expected->>'fingerprint');
    actual_reference:=CASE WHEN recipient.person_id IS NOT NULL THEN jsonb_build_object('kind','PERSON','id',recipient.person_id)
      WHEN recipient.owner_id IS NOT NULL THEN jsonb_build_object('kind','OWNER','id',recipient.owner_id)
      WHEN recipient.guest_id IS NOT NULL THEN jsonb_build_object('kind','GUEST','id',recipient.guest_id)
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
    OR EXISTS(SELECT 1 FROM signature_event e WHERE e.organization_id=original.organization_id AND e.signature_id=original.id AND e.state<>'DRAFT' AND NOT app_native_signature_distribution_event_valid(e))
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

