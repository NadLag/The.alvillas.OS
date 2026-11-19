BEGIN;

CREATE TABLE personal_finance_entry (
    organization_id uuid NOT NULL,
    household_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT app_uuid_v7(),
    command_id uuid NOT NULL,
    kind text NOT NULL,
    series_id uuid NOT NULL,
    label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
    category text NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 80),
    amount numeric(18,2) NOT NULL CHECK (amount >= 0),
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    effective_on date NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz(6) NOT NULL DEFAULT now(),
    reverses_id uuid,
    goal_id uuid,
    withdrawal boolean NOT NULL DEFAULT false,
    closed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (organization_id, household_id, id),
    CONSTRAINT personal_finance_entry_command_unique UNIQUE (organization_id, household_id, command_id),
    CONSTRAINT personal_finance_entry_actor_fk FOREIGN KEY (organization_id, household_id, created_by)
        REFERENCES personal_member(organization_id, household_id, account_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT personal_finance_entry_reverses_fk FOREIGN KEY (organization_id, household_id, reverses_id)
        REFERENCES personal_finance_entry(organization_id, household_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT personal_finance_entry_goal_fk FOREIGN KEY (organization_id, household_id, goal_id)
        REFERENCES personal_finance_entry(organization_id, household_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT personal_finance_entry_kind CHECK (
        kind IN ('INCOME','EXPENSE','BUDGET','SAVINGS_GOAL','SAVINGS_MOVEMENT','INVESTMENT','ASSET','LIABILITY')
        AND ((kind = 'SAVINGS_MOVEMENT') = (goal_id IS NOT NULL))
        AND (NOT withdrawal OR kind = 'SAVINGS_MOVEMENT')
        AND (reverses_id IS NULL OR (reverses_id <> id AND kind IN ('INCOME','EXPENSE','SAVINGS_MOVEMENT')))
        AND (kind NOT IN ('INCOME','EXPENSE','SAVINGS_MOVEMENT') OR (series_id = id AND NOT closed AND amount > 0))
        AND (NOT closed OR reverses_id IS NULL)
        AND (kind NOT IN ('BUDGET','SAVINGS_GOAL') OR amount > 0)
    ),
    CONSTRAINT personal_finance_entry_reversal_unique UNIQUE (organization_id, household_id, reverses_id)
);

CREATE INDEX personal_finance_entry_kind_date_idx ON personal_finance_entry
    (organization_id, household_id, kind, effective_on DESC, id DESC);
CREATE INDEX personal_finance_entry_kind_series_idx ON personal_finance_entry
    (organization_id, household_id, kind, series_id, effective_on DESC, created_at DESC, id DESC);
CREATE INDEX personal_finance_entry_goal_idx ON personal_finance_entry (organization_id, household_id, goal_id);

ALTER TABLE personal_finance_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_finance_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_finance_entry_tenant_isolation ON personal_finance_entry
    USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND EXISTS (SELECT 1 FROM personal_member member
            WHERE member.organization_id = personal_finance_entry.organization_id AND member.household_id = personal_finance_entry.household_id
              AND member.account_id = nullif(current_setting('app.personal_actor_id', true), '')::uuid
              AND member.revoked_at IS NULL))
    WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
        AND household_id = nullif(current_setting('app.personal_household_id', true), '')::uuid
        AND created_by = nullif(current_setting('app.personal_actor_id', true), '')::uuid);

CREATE FUNCTION personal_finance_validate_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source personal_finance_entry%ROWTYPE;
BEGIN
    IF NEW.reverses_id IS NOT NULL THEN
        SELECT * INTO STRICT source FROM personal_finance_entry
         WHERE organization_id = NEW.organization_id AND household_id = NEW.household_id AND id = NEW.reverses_id;
        IF source.reverses_id IS NOT NULL OR (NEW.kind,NEW.label,NEW.category,NEW.amount,NEW.currency,NEW.effective_on,NEW.goal_id,NEW.withdrawal)
            IS DISTINCT FROM (source.kind,source.label,source.category,source.amount,source.currency,source.effective_on,source.goal_id,source.withdrawal) THEN
            RAISE EXCEPTION 'Invalid personal financial reversal' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.goal_id IS NOT NULL THEN
        SELECT * INTO STRICT source FROM personal_finance_entry
         WHERE organization_id = NEW.organization_id AND household_id = NEW.household_id AND id = NEW.goal_id;
        IF source.kind <> 'SAVINGS_GOAL' OR source.series_id <> source.id OR source.currency <> NEW.currency THEN
            RAISE EXCEPTION 'Invalid personal savings source' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.series_id <> NEW.id THEN
        SELECT * INTO STRICT source FROM personal_finance_entry
         WHERE organization_id = NEW.organization_id AND household_id = NEW.household_id AND id = NEW.series_id;
        IF source.kind <> NEW.kind OR source.series_id <> source.id OR source.currency <> NEW.currency
           OR ((NEW.kind = 'BUDGET') AND
               (source.category <> NEW.category OR date_trunc('month',source.effective_on) <> date_trunc('month',NEW.effective_on))) THEN
            RAISE EXCEPTION 'Invalid personal financial revision' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER personal_finance_entry_source BEFORE INSERT ON personal_finance_entry
    FOR EACH ROW EXECUTE FUNCTION personal_finance_validate_source();
CREATE TRIGGER personal_finance_entry_immutable BEFORE UPDATE OR DELETE ON personal_finance_entry
    FOR EACH ROW EXECUTE FUNCTION personal_reject_history_mutation();
CREATE TRIGGER personal_finance_entry_no_truncate BEFORE TRUNCATE ON personal_finance_entry
    FOR EACH STATEMENT EXECUTE FUNCTION personal_reject_history_mutation();

COMMIT;
