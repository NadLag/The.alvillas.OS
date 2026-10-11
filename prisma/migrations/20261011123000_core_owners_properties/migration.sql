CREATE TABLE owner (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  legal_name text,
  email text,
  phone text,
  preferred_locale char(2) NOT NULL DEFAULT 'fr',
  notes text,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_preferred_locale_check CHECK (preferred_locale IN ('en', 'fr', 'ar')),
  CONSTRAINT owner_email_lowercase_check CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT owner_org_email_unique UNIQUE (organization_id, email)
);

CREATE INDEX owner_org_display_name_idx
  ON owner (organization_id, display_name);

CREATE INDEX owner_org_archived_idx
  ON owner (organization_id, archived_at);

CREATE TABLE property (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  name text NOT NULL,
  address_line_1 text NOT NULL,
  address_line_2 text,
  city text NOT NULL,
  region text,
  country_code char(2) NOT NULL DEFAULT 'MA',
  property_type text NOT NULL,
  bedrooms integer NOT NULL,
  bathrooms integer NOT NULL,
  living_spaces integer NOT NULL DEFAULT 1,
  has_pool boolean NOT NULL DEFAULT false,
  has_garden boolean NOT NULL DEFAULT false,
  parking_spaces integer NOT NULL DEFAULT 0,
  max_guests integer NOT NULL,
  timezone text NOT NULL DEFAULT 'Africa/Casablanca',
  amenities jsonb NOT NULL,
  photo_urls jsonb NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_country_code_uppercase_check CHECK (country_code = upper(country_code)),
  CONSTRAINT property_counts_check CHECK (
    bedrooms >= 0
    AND bathrooms >= 0
    AND living_spaces >= 0
    AND parking_spaces >= 0
    AND max_guests > 0
  ),
  CONSTRAINT property_status_check CHECK (status IN ('DRAFT', 'ONBOARDING', 'ACTIVE', 'PAUSED', 'OFFBOARDED')),
  CONSTRAINT property_amenities_array_check CHECK (jsonb_typeof(amenities) = 'array'),
  CONSTRAINT property_photo_urls_array_check CHECK (jsonb_typeof(photo_urls) = 'array')
);

CREATE INDEX property_org_city_name_idx
  ON property (organization_id, city, name);

CREATE INDEX property_org_status_idx
  ON property (organization_id, status);

CREATE INDEX property_org_archived_idx
  ON property (organization_id, archived_at);

CREATE TABLE property_owner (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES owner(id) ON DELETE RESTRICT,
  share_bps integer NOT NULL DEFAULT 10000,
  is_primary boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_owner_share_check CHECK (share_bps > 0 AND share_bps <= 10000),
  CONSTRAINT property_owner_org_property_owner_unique UNIQUE (organization_id, property_id, owner_id)
);

CREATE INDEX property_owner_org_owner_idx
  ON property_owner (organization_id, owner_id);

CREATE INDEX property_owner_org_property_idx
  ON property_owner (organization_id, property_id);

ALTER TABLE owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner FORCE ROW LEVEL SECURITY;
ALTER TABLE property ENABLE ROW LEVEL SECURITY;
ALTER TABLE property FORCE ROW LEVEL SECURITY;
ALTER TABLE property_owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_owner FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_tenant_isolation ON owner
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY property_tenant_isolation ON property
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY property_owner_tenant_isolation ON property_owner
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
