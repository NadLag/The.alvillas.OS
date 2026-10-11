CREATE TABLE owner_portal_access (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES owner(id) ON DELETE RESTRICT,
  user_account_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_portal_access_org_owner_user_unique UNIQUE (
    organization_id,
    owner_id,
    user_account_id
  )
);

CREATE INDEX owner_portal_access_org_user_idx
  ON owner_portal_access (organization_id, user_account_id, archived_at);

CREATE INDEX owner_portal_access_org_owner_idx
  ON owner_portal_access (organization_id, owner_id, archived_at);

CREATE INDEX posting_dimensions_gin_idx
  ON posting USING gin (dimensions jsonb_path_ops);

CREATE OR REPLACE FUNCTION app_assert_owner_portal_access_organization_consistency()
RETURNS trigger AS $$
DECLARE
  linked_owner_org uuid;
  linked_user_org uuid;
BEGIN
  SELECT organization_id INTO linked_owner_org
  FROM owner
  WHERE id = NEW.owner_id;

  SELECT organization_id INTO linked_user_org
  FROM user_account
  WHERE id = NEW.user_account_id;

  IF NEW.organization_id <> linked_owner_org OR NEW.organization_id <> linked_user_org THEN
    RAISE EXCEPTION 'owner portal access organization mismatch';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER owner_portal_access_organization_consistency
BEFORE INSERT OR UPDATE ON owner_portal_access
FOR EACH ROW EXECUTE FUNCTION app_assert_owner_portal_access_organization_consistency();

ALTER TABLE owner_portal_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_portal_access FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_portal_access_tenant_isolation ON owner_portal_access
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
