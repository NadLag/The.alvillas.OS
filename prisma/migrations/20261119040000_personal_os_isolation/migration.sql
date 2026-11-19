BEGIN;

CREATE TABLE personal_household (
    organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    id uuid NOT NULL DEFAULT app_uuid_v7(),
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    created_at timestamptz(6) NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id)
);

CREATE TABLE personal_member (
    organization_id uuid NOT NULL,
    household_id uuid NOT NULL,
    account_id uuid NOT NULL,
    display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
    is_child boolean NOT NULL,
    is_steward boolean NOT NULL DEFAULT false,
    grants text[] NOT NULL,
    revoked_at timestamptz(6),
    PRIMARY KEY (organization_id, household_id, account_id),
    CONSTRAINT personal_member_household_fk FOREIGN KEY (organization_id, household_id)
        REFERENCES personal_household(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT personal_member_account_fk FOREIGN KEY (organization_id, account_id)
        REFERENCES user_account(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT personal_member_steward_check CHECK (NOT is_steward OR (NOT is_child AND revoked_at IS NULL)),
    CONSTRAINT personal_member_grants_check CHECK (
        array_position(grants, NULL) IS NULL AND grants <@ ARRAY[
            'income:view', 'income:edit', 'expenses:view', 'expenses:edit',
            'budgets:view', 'budgets:edit', 'savings:view', 'savings:edit',
            'investments:view', 'investments:edit', 'positions:view', 'positions:edit',
            'documents:view', 'documents:edit', 'reports:view', 'transfers:view', 'transfers:edit'
        ]::text[]
    )
);
CREATE INDEX personal_member_account_idx ON personal_member(organization_id, account_id, household_id);

CREATE TABLE personal_audit_event (
    organization_id uuid NOT NULL,
    household_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT app_uuid_v7(),
    actor_id uuid NOT NULL,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid,
    ip_address text,
    device_id text,
    before jsonb,
    after jsonb,
    reason text,
    request_id text NOT NULL,
    occurred_at timestamptz(6) NOT NULL,
    PRIMARY KEY (organization_id, household_id, id),
    CONSTRAINT personal_audit_event_actor_fk FOREIGN KEY (organization_id, household_id, actor_id)
        REFERENCES personal_member(organization_id, household_id, account_id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX personal_audit_event_timeline_idx ON personal_audit_event(organization_id, household_id, occurred_at, id);

ALTER TABLE personal_household ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_household FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_household_tenant_isolation ON personal_household
    USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND nullif(current_setting('app.personal_actor_id', true), '') IS NOT NULL);

ALTER TABLE personal_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_member FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_member_tenant_isolation ON personal_member
    USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND nullif(current_setting('app.personal_actor_id', true), '') IS NOT NULL
        AND (household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
            OR (nullif(current_setting('app.personal_household_id', true), '') IS NULL
                AND account_id = nullif(current_setting('app.personal_actor_id', true), '')::uuid)))
    WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND nullif(current_setting('app.personal_actor_id', true), '') IS NOT NULL);

ALTER TABLE personal_audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_audit_event_tenant_isolation ON personal_audit_event
    USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND nullif(current_setting('app.personal_actor_id', true), '') IS NOT NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND actor_id = nullif(current_setting('app.personal_actor_id', true), '')::uuid);

CREATE FUNCTION personal_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Personal history is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER personal_audit_event_immutable BEFORE UPDATE OR DELETE ON personal_audit_event
    FOR EACH ROW EXECUTE FUNCTION personal_reject_history_mutation();
CREATE TRIGGER personal_audit_event_no_truncate BEFORE TRUNCATE ON personal_audit_event
    FOR EACH STATEMENT EXECUTE FUNCTION personal_reject_history_mutation();

COMMIT;
