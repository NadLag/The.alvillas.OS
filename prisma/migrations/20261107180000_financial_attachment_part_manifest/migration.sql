BEGIN;
ALTER TABLE financial_attachment_admission ADD COLUMN upload_parts JSONB;

CREATE FUNCTION app_financial_attachment_parts_valid(value JSONB,total_bytes INTEGER,transport JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE request_limit NUMERIC; window_seconds NUMERIC;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object'
  OR value IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'chunkBytes',1048576,'hashes',value->'hashes')
  OR jsonb_typeof(value->'hashes') IS DISTINCT FROM 'array'
  OR total_bytes<1 OR total_bytes>52428800
 THEN RETURN false; END IF;
 IF jsonb_typeof(transport) IS DISTINCT FROM 'object'
  OR transport IS DISTINCT FROM jsonb_build_object('max_requests',transport->'max_requests','window_seconds',transport->'window_seconds')
  OR jsonb_typeof(transport->'max_requests') IS DISTINCT FROM 'number'
  OR jsonb_typeof(transport->'window_seconds') IS DISTINCT FROM 'number'
 THEN RETURN false; END IF;
 request_limit:=(transport->>'max_requests')::numeric;
 window_seconds:=(transport->>'window_seconds')::numeric;
 IF request_limit<>trunc(request_limit) OR request_limit NOT BETWEEN 1 AND 2147483647
  OR window_seconds<>trunc(window_seconds) OR window_seconds NOT BETWEEN 1 AND 2147483647
 THEN RETURN false; END IF;
 IF jsonb_array_length(value->'hashes') NOT BETWEEN 1 AND 64
  OR jsonb_array_length(value->'hashes')<>(total_bytes+1048575)/1048576
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(value->'hashes') AS part(hash)
    WHERE jsonb_typeof(part.hash) IS DISTINCT FROM 'string' OR part.hash#>>'{}' !~ '^[a-f0-9]{64}$')
 THEN RETURN false; END IF;
 RETURN true;
END $$;

ALTER TABLE financial_attachment_admission ADD CONSTRAINT financial_attachment_original_part_manifest
 CHECK(upload_parts IS NULL OR coalesce(app_financial_attachment_parts_valid(upload_parts,file_size,policy_snapshot#>'{value,upload_transport}'),false));
COMMIT;
