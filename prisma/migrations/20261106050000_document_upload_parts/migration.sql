BEGIN;

CREATE INDEX document_admission_nonce_owner_idx ON document_admission(organization_id,command_key);

-- Version-one transport framing; the configured type still controls file size and classification.
CREATE FUNCTION app_document_parts_valid(document_input jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=public,pg_temp AS $$
DECLARE parts jsonb; hash jsonb; entries integer; byte_count integer;
BEGIN
  IF NOT document_input?'parts' THEN RETURN true; END IF;
  parts:=document_input->'parts';
  IF jsonb_typeof(parts) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  SELECT count(*) INTO entries FROM jsonb_object_keys(parts);
  IF entries<>3 OR parts->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR parts->'chunkBytes' IS DISTINCT FROM '262144'::jsonb
    OR jsonb_typeof(parts->'hashes') IS DISTINCT FROM 'array' OR jsonb_typeof(document_input->'fileSize') IS DISTINCT FROM 'number'
  THEN RETURN false; END IF;
  byte_count:=(document_input->>'fileSize')::integer;
  IF byte_count<1 OR byte_count>10485760 OR jsonb_array_length(parts->'hashes')<>(byte_count+262143)/262144
    OR jsonb_array_length(parts->'hashes') NOT BETWEEN 1 AND 64 THEN RETURN false; END IF;
  FOR hash IN SELECT value FROM jsonb_array_elements(parts->'hashes') LOOP
    IF jsonb_typeof(hash) IS DISTINCT FROM 'string' OR NOT (hash#>>'{}') ~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

ALTER TABLE document_admission ADD CONSTRAINT document_admission_parts_shape CHECK (app_document_parts_valid(input));

COMMIT;
