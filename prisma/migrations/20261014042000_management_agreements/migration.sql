CREATE TABLE management_agreement (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  reference text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_by uuid,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT management_agreement_reference_not_blank CHECK (btrim(reference) <> ''),
  CONSTRAINT management_agreement_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'ENDED')),
  CONSTRAINT management_agreement_effective_range_check CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX management_agreement_org_property_reference_unique
  ON management_agreement (organization_id, property_id, lower(reference))
  WHERE archived_at IS NULL;

CREATE INDEX management_agreement_org_property_status_idx
  ON management_agreement (organization_id, property_id, status, effective_from DESC);

CREATE INDEX management_agreement_org_archived_idx
  ON management_agreement (organization_id, archived_at);

CREATE OR REPLACE FUNCTION app_assert_management_agreement_property_organization_consistency()
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
    RAISE EXCEPTION 'management agreement property organization mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER management_agreement_property_organization_consistency
BEFORE INSERT OR UPDATE ON management_agreement
FOR EACH ROW EXECUTE FUNCTION app_assert_management_agreement_property_organization_consistency();

CREATE TRIGGER management_agreement_no_delete
BEFORE DELETE ON management_agreement
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

ALTER TABLE management_agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE management_agreement FORCE ROW LEVEL SECURITY;

CREATE POLICY management_agreement_tenant_isolation ON management_agreement
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
