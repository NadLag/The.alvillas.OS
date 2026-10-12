ALTER TABLE user_account
  ADD COLUMN phone text,
  ADD COLUMN session_version integer NOT NULL DEFAULT 1,
  ADD COLUMN mfa_required boolean NOT NULL DEFAULT false,
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN deactivated_at timestamptz,
  ADD CONSTRAINT user_account_phone_lowercase_check CHECK (phone IS NULL OR phone = lower(phone)),
  ADD CONSTRAINT user_account_session_version_positive_check CHECK (session_version > 0);

ALTER TABLE person
  ADD CONSTRAINT person_phone_lowercase_check CHECK (phone IS NULL OR phone = lower(phone));

ALTER TABLE user_account
  ADD CONSTRAINT user_account_org_phone_unique UNIQUE (organization_id, phone);

CREATE INDEX user_account_org_status_idx
  ON user_account (organization_id, status);

CREATE INDEX person_org_phone_idx
  ON person (organization_id, phone);

CREATE TABLE auth_credential (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  user_account_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  type text NOT NULL,
  label text,
  secret_hash text,
  secret_encrypted text,
  credential_id text,
  public_key bytea,
  counter integer NOT NULL DEFAULT 0,
  transports jsonb,
  backup_eligible boolean NOT NULL DEFAULT false,
  backed_up boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_credential_type_check CHECK (type IN ('PASSWORD', 'PIN', 'TOTP', 'PASSKEY', 'RECOVERY_CODE')),
  CONSTRAINT auth_credential_secret_shape_check CHECK (
    (type IN ('PASSWORD', 'PIN', 'RECOVERY_CODE') AND secret_hash IS NOT NULL)
    OR (type = 'TOTP' AND secret_encrypted IS NOT NULL)
    OR (type = 'PASSKEY' AND credential_id IS NOT NULL AND public_key IS NOT NULL)
  ),
  CONSTRAINT auth_credential_counter_non_negative_check CHECK (counter >= 0)
);

INSERT INTO auth_credential (
  organization_id,
  user_account_id,
  type,
  label,
  secret_hash
)
SELECT
  organization_id,
  id,
  'PASSWORD',
  'Password',
  password_hash
FROM user_account
WHERE password_hash IS NOT NULL;

ALTER TABLE auth_credential
  ADD CONSTRAINT auth_credential_org_type_credential_unique UNIQUE (organization_id, type, credential_id);

CREATE INDEX auth_credential_org_user_type_idx
  ON auth_credential (organization_id, user_account_id, type, revoked_at);

CREATE TABLE auth_session (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  user_account_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  device_id text NOT NULL,
  session_version integer NOT NULL,
  user_agent text,
  ip_address text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_session_version_positive_check CHECK (session_version > 0)
);

CREATE INDEX auth_session_org_user_active_idx
  ON auth_session (organization_id, user_account_id, revoked_at, expires_at);

CREATE INDEX auth_session_org_device_idx
  ON auth_session (organization_id, device_id);

CREATE TABLE auth_device (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  user_account_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  device_id text NOT NULL,
  label text,
  platform text,
  trusted boolean NOT NULL DEFAULT false,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_device_device_id_not_blank CHECK (length(trim(device_id)) > 0)
);

CREATE UNIQUE INDEX auth_device_org_user_device_unique
  ON auth_device (organization_id, user_account_id, device_id);

CREATE INDEX auth_device_org_user_idx
  ON auth_device (organization_id, user_account_id, revoked_at);

CREATE TABLE auth_challenge (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  user_account_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
  type text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_challenge_type_check CHECK (type IN ('PASSKEY_REGISTRATION', 'PASSKEY_AUTHENTICATION'))
);

CREATE INDEX auth_challenge_org_type_expires_idx
  ON auth_challenge (organization_id, type, expires_at);

CREATE TABLE role (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  key text NOT NULL,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_key_not_blank CHECK (length(trim(key)) > 0)
);

ALTER TABLE role
  ADD CONSTRAINT role_org_key_unique UNIQUE (organization_id, key);

CREATE INDEX role_org_archived_idx
  ON role (organization_id, archived_at);

CREATE TABLE permission (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  key text NOT NULL,
  resource text NOT NULL,
  action text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permission_key_not_blank CHECK (length(trim(key)) > 0)
);

ALTER TABLE permission
  ADD CONSTRAINT permission_org_key_unique UNIQUE (organization_id, key);

CREATE INDEX permission_org_resource_action_idx
  ON permission (organization_id, resource, action);

CREATE TABLE role_permission (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES role(id) ON DELETE RESTRICT,
  permission_id uuid NOT NULL REFERENCES permission(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, role_id, permission_id)
);

CREATE INDEX role_permission_org_permission_idx
  ON role_permission (organization_id, permission_id);

CREATE TABLE role_assignment (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  user_account_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES role(id) ON DELETE RESTRICT,
  scope_type text NOT NULL,
  scope_id uuid,
  conditions jsonb,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  compensation_ref text,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_assignment_scope_check CHECK (scope_type IN ('organization', 'property', 'owner', 'field_team')),
  CONSTRAINT role_assignment_valid_window_check CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX role_assignment_org_person_idx
  ON role_assignment (organization_id, person_id, archived_at);

CREATE INDEX role_assignment_org_account_idx
  ON role_assignment (organization_id, user_account_id, archived_at);

CREATE INDEX role_assignment_org_role_scope_idx
  ON role_assignment (organization_id, role_id, scope_type, scope_id);

CREATE TABLE invitation (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  user_account_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES role(id) ON DELETE RESTRICT,
  scope_type text NOT NULL,
  scope_id uuid,
  email text,
  phone text,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitation_scope_check CHECK (scope_type IN ('organization', 'property', 'owner', 'field_team')),
  CONSTRAINT invitation_email_lowercase_check CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT invitation_phone_lowercase_check CHECK (phone IS NULL OR phone = lower(phone))
);

ALTER TABLE invitation
  ADD CONSTRAINT invitation_org_code_hash_unique UNIQUE (organization_id, code_hash);

CREATE INDEX invitation_org_person_state_idx
  ON invitation (organization_id, person_id, accepted_at, revoked_at);

CREATE INDEX invitation_org_expires_idx
  ON invitation (organization_id, expires_at);

ALTER TABLE auth_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_credential FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_device FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_challenge FORCE ROW LEVEL SECURITY;
ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation FORCE ROW LEVEL SECURITY;
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;
ALTER TABLE permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission FORCE ROW LEVEL SECURITY;
ALTER TABLE role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignment FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_credential_tenant_isolation ON auth_credential
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY auth_session_tenant_isolation ON auth_session
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY auth_device_tenant_isolation ON auth_device
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY auth_challenge_tenant_isolation ON auth_challenge
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY invitation_tenant_isolation ON invitation
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY role_tenant_isolation ON role
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY permission_tenant_isolation ON permission
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY role_permission_tenant_isolation ON role_permission
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY role_assignment_tenant_isolation ON role_assignment
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
