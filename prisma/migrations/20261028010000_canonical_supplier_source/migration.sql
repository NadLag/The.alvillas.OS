BEGIN;

CREATE TABLE supplier (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(), organization_id uuid NOT NULL,
 reference text NOT NULL, display_name text NOT NULL, category text NOT NULL,
 contact_name text, email text, phone text, address text, external_reference text,
 idempotency_key uuid NOT NULL, request_fingerprint text NOT NULL, version integer NOT NULL DEFAULT 0,
 archived_at timestamptz(6), created_by uuid NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT supplier_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT supplier_organization_id_created_by_fkey FOREIGN KEY (organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT supplier_organization_id_id_key UNIQUE (organization_id,id),
 CONSTRAINT supplier_organization_id_reference_key UNIQUE (organization_id,reference),
 CONSTRAINT supplier_organization_id_idempotency_key_key UNIQUE (organization_id,idempotency_key),
 CONSTRAINT supplier_valid_fields CHECK (length(btrim(display_name)) BETWEEN 1 AND 200 AND length(btrim(category)) BETWEEN 1 AND 80
  AND (contact_name IS NULL OR length(contact_name)<=200) AND (email IS NULL OR length(email)<=254)
  AND (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$') AND (address IS NULL OR length(address)<=1000)
  AND (external_reference IS NULL OR length(external_reference)<=100) AND version>=0 AND request_fingerprint ~ '^[0-9a-f]{64}$')
);
CREATE INDEX supplier_organization_id_archived_at_id_idx ON supplier(organization_id,archived_at,id);
CREATE INDEX supplier_organization_id_category_archived_at_id_idx ON supplier(organization_id,category,archived_at,id);
ALTER TABLE supplier ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_organization_isolation ON supplier USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER supplier_no_delete BEFORE DELETE ON supplier FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

CREATE FUNCTION app_supplier_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>0 THEN RAISE EXCEPTION 'supplier starts at source version zero'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.organization_id,NEW.reference,NEW.idempotency_key,NEW.request_fingerprint,NEW.created_by,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.reference,OLD.idempotency_key,OLD.request_fingerprint,OLD.created_by,OLD.created_at)
   OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'supplier identity is immutable and edits require the next source version'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_source_guard BEFORE INSERT OR UPDATE ON supplier FOR EACH ROW EXECUTE FUNCTION app_supplier_source_guard();

CREATE FUNCTION app_supplier_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log a JOIN user_account u ON u.organization_id=a.organization_id AND u.id=a.actor_id
  WHERE a.organization_id=NEW.organization_id AND a.resource_type='supplier' AND a.resource_id=NEW.id
   AND a.action IN ('finance.supplier.created','finance.supplier.updated','finance.supplier.archived','finance.supplier.restored')
   AND a.after->>'version'=NEW.version::text AND length(btrim(a.reason))>=6
   AND (TG_OP<>'INSERT' OR a.actor_id=NEW.created_by)
   AND (TG_OP<>'UPDATE' OR a.before->>'version'=OLD.version::text))
 THEN RAISE EXCEPTION 'supplier changes require an attributed versioned audit in the same transaction'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER supplier_audit_guard AFTER INSERT OR UPDATE ON supplier DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_supplier_audit_guard();

COMMIT;
