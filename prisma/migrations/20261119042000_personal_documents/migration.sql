BEGIN;
CREATE TABLE personal_document (
    organization_id uuid NOT NULL,
    household_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT app_uuid_v7(),
    command_id uuid NOT NULL,
    display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
    content_type text NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png')),
    content_hash char(64) NOT NULL,
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) <= 3000256),
    archived_at timestamptz(6),
    created_by uuid NOT NULL,
    created_at timestamptz(6) NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, household_id, id),
    CONSTRAINT personal_document_command_unique UNIQUE (organization_id, household_id, command_id),
    CONSTRAINT personal_document_creator_fk FOREIGN KEY (organization_id, household_id, created_by)
        REFERENCES personal_member(organization_id, household_id, account_id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX personal_document_timeline_idx ON personal_document(organization_id, household_id, id DESC);
ALTER TABLE personal_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_document FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_document_tenant_isolation ON personal_document
    USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND EXISTS (SELECT 1 FROM personal_member member
            WHERE member.organization_id = personal_document.organization_id AND member.household_id = personal_document.household_id
              AND member.account_id = nullif(current_setting('app.personal_actor_id', true), '')::uuid
              AND member.revoked_at IS NULL));
CREATE FUNCTION personal_document_protect_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'archived_at') IS DISTINCT FROM (to_jsonb(OLD) - 'archived_at') THEN
        RAISE EXCEPTION 'Personal document original is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER personal_document_immutable BEFORE UPDATE OR DELETE ON personal_document
    FOR EACH ROW EXECUTE FUNCTION personal_document_protect_original();
CREATE TRIGGER personal_document_no_truncate BEFORE TRUNCATE ON personal_document
    FOR EACH STATEMENT EXECUTE FUNCTION personal_reject_history_mutation();
COMMIT;
