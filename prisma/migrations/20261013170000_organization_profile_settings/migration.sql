ALTER TABLE organization
  ADD CONSTRAINT organization_base_currency_uppercase_check CHECK (base_currency = upper(base_currency));

CREATE TABLE organization_profile (
  organization_id uuid PRIMARY KEY REFERENCES organization(id) ON DELETE RESTRICT,
  legal_name text,
  brand_name text NOT NULL,
  logo_url text,
  primary_color text NOT NULL DEFAULT '#0B6B5F',
  accent_color text NOT NULL DEFAULT '#9F3F1B',
  website_url text,
  support_email text,
  support_phone text,
  default_locale char(2) NOT NULL DEFAULT 'fr',
  timezone text NOT NULL DEFAULT 'Africa/Casablanca',
  country_code char(2) NOT NULL DEFAULT 'MA',
  fiscal_year_start_month integer NOT NULL DEFAULT 1,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_profile_locale_check CHECK (default_locale IN ('en', 'fr', 'ar')),
  CONSTRAINT organization_profile_country_uppercase_check CHECK (country_code = upper(country_code)),
  CONSTRAINT organization_profile_fiscal_month_check CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  CONSTRAINT organization_profile_primary_color_check CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT organization_profile_accent_color_check CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT organization_profile_logo_url_check CHECK (logo_url IS NULL OR logo_url ~ '^https://'),
  CONSTRAINT organization_profile_website_url_check CHECK (website_url IS NULL OR website_url ~ '^https://'),
  CONSTRAINT organization_profile_email_lowercase_check CHECK (support_email IS NULL OR support_email = lower(support_email)),
  CONSTRAINT organization_profile_settings_object_check CHECK (jsonb_typeof(settings) = 'object')
);

INSERT INTO organization_profile (
  organization_id,
  legal_name,
  brand_name,
  default_locale,
  timezone,
  country_code,
  settings
)
SELECT
  id,
  name,
  name,
  'fr',
  'Africa/Casablanca',
  'MA',
  '{}'::jsonb
FROM organization
ON CONFLICT (organization_id) DO NOTHING;

CREATE INDEX organization_profile_country_locale_idx
  ON organization_profile (country_code, default_locale);

CREATE OR REPLACE FUNCTION app_prevent_business_row_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'business rows must be archived, not deleted';
END;
$$;

CREATE TRIGGER organization_profile_no_delete
BEFORE DELETE ON organization_profile
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

ALTER TABLE organization_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_profile FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_profile_tenant_isolation ON organization_profile
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

INSERT INTO permission (organization_id, key, resource, action, description)
SELECT o.id, 'organization:' || action, 'organization', action, action || ' organization'
FROM organization o
CROSS JOIN (VALUES
  ('view'),
  ('edit'),
  ('configure')
) AS actions(action)
ON CONFLICT (organization_id, key) DO UPDATE
SET resource = EXCLUDED.resource,
    action = EXCLUDED.action,
    description = EXCLUDED.description;

INSERT INTO role_permission (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM role r
JOIN permission p
  ON p.organization_id = r.organization_id
 AND p.key IN ('organization:view', 'organization:edit', 'organization:configure')
WHERE r.key = 'admin'
  AND r.archived_at IS NULL
ON CONFLICT (organization_id, role_id, permission_id) DO NOTHING;
