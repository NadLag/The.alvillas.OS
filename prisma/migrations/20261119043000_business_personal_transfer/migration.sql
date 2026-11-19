BEGIN;
CREATE TABLE business_personal_transfer (
    organization_id uuid NOT NULL,
    household_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT app_uuid_v7(),
    command_id uuid NOT NULL,
    category text NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 80),
    direction text NOT NULL CHECK (direction IN ('TO_PERSONAL','TO_BUSINESS')),
    amount numeric(18,2) NOT NULL CHECK (amount > 0),
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    effective_on date NOT NULL,
    requested_by uuid NOT NULL,
    requested_at timestamptz(6) NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, household_id, id),
    CONSTRAINT business_personal_transfer_command_unique UNIQUE (organization_id, household_id, command_id),
    CONSTRAINT business_personal_transfer_requester_fk FOREIGN KEY (organization_id, household_id, requested_by)
        REFERENCES personal_member(organization_id, household_id, account_id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE TABLE personal_transfer_resolution (
    organization_id uuid NOT NULL,
    household_id uuid NOT NULL,
    transfer_id uuid NOT NULL,
    kind text NOT NULL,
    business_transaction_id uuid,
    policy_rule_id uuid,
    actor_id uuid NOT NULL,
    occurred_at timestamptz(6) NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, household_id, transfer_id),
    CONSTRAINT personal_transfer_resolution_transfer_fk FOREIGN KEY (organization_id, household_id, transfer_id)
        REFERENCES business_personal_transfer(organization_id, household_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT personal_transfer_resolution_actor_fk FOREIGN KEY (organization_id, household_id, actor_id)
        REFERENCES personal_member(organization_id, household_id, account_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT personal_transfer_resolution_transaction_fk FOREIGN KEY (organization_id, business_transaction_id)
        REFERENCES financial_transaction(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT personal_transfer_resolution_business_unique UNIQUE (organization_id, business_transaction_id),
    CONSTRAINT personal_transfer_resolution_kind CHECK (
        (kind = 'CONFIRMED' AND business_transaction_id IS NOT NULL AND policy_rule_id IS NOT NULL)
        OR (kind = 'CANCELLED' AND business_transaction_id IS NULL AND policy_rule_id IS NULL)
    )
);
ALTER TABLE business_personal_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_personal_transfer FORCE ROW LEVEL SECURITY;
CREATE POLICY business_personal_transfer_tenant_isolation ON business_personal_transfer
    USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND EXISTS (SELECT 1 FROM personal_member member
            WHERE member.organization_id = business_personal_transfer.organization_id AND member.household_id = business_personal_transfer.household_id
              AND member.account_id = nullif(current_setting('app.personal_actor_id', true), '')::uuid
              AND member.revoked_at IS NULL))
    WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND requested_by = nullif(current_setting('app.personal_actor_id', true), '')::uuid);
ALTER TABLE personal_transfer_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_transfer_resolution FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_transfer_resolution_tenant_isolation ON personal_transfer_resolution
    USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND EXISTS (SELECT 1 FROM personal_member member
            WHERE member.organization_id = personal_transfer_resolution.organization_id AND member.household_id = personal_transfer_resolution.household_id
              AND member.account_id = nullif(current_setting('app.personal_actor_id', true), '')::uuid
              AND member.revoked_at IS NULL))
    WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND actor_id = nullif(current_setting('app.personal_actor_id', true), '')::uuid);
CREATE TRIGGER business_personal_transfer_immutable BEFORE UPDATE OR DELETE ON business_personal_transfer
    FOR EACH ROW EXECUTE FUNCTION personal_reject_history_mutation();
CREATE TRIGGER business_personal_transfer_no_truncate BEFORE TRUNCATE ON business_personal_transfer
    FOR EACH STATEMENT EXECUTE FUNCTION personal_reject_history_mutation();
CREATE TRIGGER personal_transfer_resolution_immutable BEFORE UPDATE OR DELETE ON personal_transfer_resolution
    FOR EACH ROW EXECUTE FUNCTION personal_reject_history_mutation();
CREATE TRIGGER personal_transfer_resolution_no_truncate BEFORE TRUNCATE ON personal_transfer_resolution
    FOR EACH STATEMENT EXECUTE FUNCTION personal_reject_history_mutation();
COMMIT;
