BEGIN;

ALTER TABLE document_admission ADD COLUMN payload_cipher BYTEA;
ALTER TABLE document_admission DROP CONSTRAINT document_admission_shape;
ALTER TABLE document_admission ADD CONSTRAINT document_admission_shape CHECK (
  file_size BETWEEN 1 AND 10485760 AND length(file_name) BETWEEN 1 AND 240 AND file_name !~ '[[:cntrl:]/\\]'
  AND content_type IN ('application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/json','text/plain','application/vnd.alvillas.document-template+json')
  AND sha256 ~ '^[a-f0-9]{64}$' AND command_hash ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND expected_revision>0 AND length(reason) BETWEEN 8 AND 1000 AND jsonb_typeof(authorization_cap)='object' AND jsonb_typeof(input)='object'
  AND storage_key='organizations/'||organization_id::text||'/documents/'||document_id::text||'/admissions/'||id::text||'.encrypted');
ALTER TABLE document_admission ADD CONSTRAINT document_template_payload_shape CHECK (
  (content_type='application/vnd.alvillas.document-template+json' AND payload_cipher IS NOT NULL
    AND file_size<=1048576 AND octet_length(payload_cipher)>file_size AND octet_length(payload_cipher)<=file_size+256
    AND NOT (input ? 'parts') AND coalesce(jsonb_typeof(policy_snapshot->'value'->'upload_transport')='object',false))
  OR (content_type<>'application/vnd.alvillas.document-template+json' AND payload_cipher IS NULL));

CREATE FUNCTION app_guard_document_template_payload() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.content_type='application/vnd.alvillas.document-template+json' AND NOT EXISTS (
    SELECT 1 FROM document d JOIN document_template t ON t.organization_id=d.organization_id AND t.document_id=d.id
    WHERE d.organization_id=NEW.organization_id AND d.id=NEW.document_id AND d.kind='TEMPLATE'
      AND t.key=NEW.input->>'templateKey' AND t.locale=NEW.input->>'locale'
  ) THEN RAISE EXCEPTION 'typed template payload requires its original native template and locale'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_template_payload_guard BEFORE INSERT ON document_admission FOR EACH ROW EXECUTE FUNCTION app_guard_document_template_payload();

COMMIT;
