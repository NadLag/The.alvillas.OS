CREATE TABLE owner_representative (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES owner(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  email text,
  phone text,
  preferred_locale char(2) NOT NULL DEFAULT 'fr',
  relationship text,
  access_notes text,
  valid_from timestamptz,
  valid_to timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE',
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_representative_locale_check CHECK (preferred_locale IN ('en', 'fr', 'ar')),
  CONSTRAINT owner_representative_email_lowercase_check CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT owner_representative_status_check CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED')),
  CONSTRAINT owner_representative_valid_range_check CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  CONSTRAINT owner_representative_org_owner_email_unique UNIQUE (organization_id, owner_id, email)
);

CREATE INDEX owner_representative_org_owner_archived_idx
  ON owner_representative (organization_id, owner_id, archived_at);

CREATE INDEX owner_representative_org_status_valid_idx
  ON owner_representative (organization_id, status, valid_to);

CREATE TABLE owner_payout_method (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES owner(id) ON DELETE RESTRICT,
  label text NOT NULL,
  method_type text NOT NULL,
  account_holder_name text NOT NULL,
  currency char(3) NOT NULL REFERENCES currency(code) ON DELETE RESTRICT,
  country_code char(2) NOT NULL,
  details_encrypted text NOT NULL,
  masked_account text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE',
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_payout_method_type_check CHECK (method_type IN ('BANK_TRANSFER', 'WISE', 'CASH', 'CHEQUE', 'OTHER')),
  CONSTRAINT owner_payout_method_currency_uppercase_check CHECK (currency = upper(currency)),
  CONSTRAINT owner_payout_method_country_uppercase_check CHECK (country_code = upper(country_code)),
  CONSTRAINT owner_payout_method_status_check CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED')),
  CONSTRAINT owner_payout_method_encrypted_check CHECK (length(details_encrypted) > 20),
  CONSTRAINT owner_payout_method_masked_check CHECK (length(masked_account) >= 4)
);

CREATE INDEX owner_payout_method_org_owner_archived_idx
  ON owner_payout_method (organization_id, owner_id, archived_at);

CREATE INDEX owner_payout_method_org_owner_default_idx
  ON owner_payout_method (organization_id, owner_id, is_default);

CREATE UNIQUE INDEX owner_payout_method_one_default_idx
  ON owner_payout_method (organization_id, owner_id)
  WHERE is_default AND archived_at IS NULL;

CREATE TABLE property_onboarding_profile (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  headline text,
  description text,
  public_directions text,
  internal_access_notes text,
  house_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  photo_gallery jsonb NOT NULL DEFAULT '[]'::jsonb,
  onboarding_checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  onboarding_notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_onboarding_profile_property_unique UNIQUE (property_id),
  CONSTRAINT property_onboarding_profile_house_rules_array_check CHECK (jsonb_typeof(house_rules) = 'array'),
  CONSTRAINT property_onboarding_profile_photo_gallery_array_check CHECK (jsonb_typeof(photo_gallery) = 'array'),
  CONSTRAINT property_onboarding_profile_checklist_object_check CHECK (jsonb_typeof(onboarding_checklist) = 'object')
);

CREATE INDEX property_onboarding_profile_org_property_idx
  ON property_onboarding_profile (organization_id, property_id);

CREATE OR REPLACE FUNCTION app_assert_owner_child_organization_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_org uuid;
BEGIN
  SELECT organization_id INTO owner_org
  FROM owner
  WHERE id = NEW.owner_id;

  IF owner_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'owner child organization mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_assert_property_profile_organization_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  property_org uuid;
BEGIN
  SELECT organization_id INTO property_org
  FROM property
  WHERE id = NEW.property_id;

  IF property_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'property onboarding organization mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_prevent_business_row_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'business rows must be archived, not deleted';
END;
$$;

CREATE TRIGGER owner_representative_organization_consistency
BEFORE INSERT OR UPDATE ON owner_representative
FOR EACH ROW EXECUTE FUNCTION app_assert_owner_child_organization_consistency();

CREATE TRIGGER owner_payout_method_organization_consistency
BEFORE INSERT OR UPDATE ON owner_payout_method
FOR EACH ROW EXECUTE FUNCTION app_assert_owner_child_organization_consistency();

CREATE TRIGGER property_onboarding_profile_organization_consistency
BEFORE INSERT OR UPDATE ON property_onboarding_profile
FOR EACH ROW EXECUTE FUNCTION app_assert_property_profile_organization_consistency();

CREATE TRIGGER owner_representative_no_delete
BEFORE DELETE ON owner_representative
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

CREATE TRIGGER owner_payout_method_no_delete
BEFORE DELETE ON owner_payout_method
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

CREATE TRIGGER property_onboarding_profile_no_delete
BEFORE DELETE ON property_onboarding_profile
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

ALTER TABLE owner_representative ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_representative FORCE ROW LEVEL SECURITY;
ALTER TABLE owner_payout_method ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_payout_method FORCE ROW LEVEL SECURITY;
ALTER TABLE property_onboarding_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_onboarding_profile FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_representative_tenant_isolation ON owner_representative
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY owner_payout_method_tenant_isolation ON owner_payout_method
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY property_onboarding_profile_tenant_isolation ON property_onboarding_profile
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
