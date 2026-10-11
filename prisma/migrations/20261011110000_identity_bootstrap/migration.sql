CREATE TABLE person (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  email text,
  phone text,
  preferred_locale char(2) NOT NULL DEFAULT 'en',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_preferred_locale_check CHECK (preferred_locale IN ('en', 'fr', 'ar')),
  CONSTRAINT person_email_lowercase_check CHECK (email IS NULL OR email = lower(email))
);

CREATE UNIQUE INDEX person_org_email_unique
  ON person (organization_id, email)
  WHERE email IS NOT NULL;

CREATE INDEX person_org_display_name_idx
  ON person (organization_id, display_name);

CREATE TABLE user_account (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  email text,
  password_hash text,
  status text NOT NULL DEFAULT 'ACTIVE',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_account_status_check CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  CONSTRAINT user_account_email_lowercase_check CHECK (email IS NULL OR email = lower(email))
);

CREATE UNIQUE INDEX user_account_org_email_unique
  ON user_account (organization_id, email)
  WHERE email IS NOT NULL;

CREATE INDEX user_account_org_person_idx
  ON user_account (organization_id, person_id);

ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE person FORCE ROW LEVEL SECURITY;
ALTER TABLE user_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_account FORCE ROW LEVEL SECURITY;

CREATE POLICY person_tenant_isolation ON person
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY user_account_tenant_isolation ON user_account
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
