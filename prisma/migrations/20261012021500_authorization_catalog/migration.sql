ALTER TABLE role_assignment
  DROP CONSTRAINT role_assignment_scope_check;

ALTER TABLE role_assignment
  ADD CONSTRAINT role_assignment_scope_check CHECK (
    scope_type IN (
      'organization',
      'region',
      'city',
      'property',
      'owner',
      'reservation',
      'job',
      'service',
      'financial_record',
      'wallet',
      'field_team'
    )
  );

ALTER TABLE invitation
  DROP CONSTRAINT invitation_scope_check;

ALTER TABLE invitation
  ADD CONSTRAINT invitation_scope_check CHECK (
    scope_type IN (
      'organization',
      'region',
      'city',
      'property',
      'owner',
      'reservation',
      'job',
      'service',
      'financial_record',
      'wallet',
      'field_team'
    )
  );

CREATE TABLE field_policy (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  resource text NOT NULL,
  field text NOT NULL,
  data_class text NOT NULL,
  required_permission text NOT NULL,
  mask text NOT NULL DEFAULT 'placeholder',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_policy_data_class_check CHECK (data_class IN ('operational', 'guest', 'financial', 'personal', 'sensitive')),
  CONSTRAINT field_policy_mask_check CHECK (mask IN ('placeholder', 'omit')),
  CONSTRAINT field_policy_resource_field_not_blank CHECK (length(trim(resource)) > 0 AND length(trim(field)) > 0)
);

ALTER TABLE field_policy
  ADD CONSTRAINT field_policy_org_resource_field_unique UNIQUE (organization_id, resource, field);

CREATE INDEX field_policy_org_resource_idx
  ON field_policy (organization_id, resource);

ALTER TABLE field_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_policy FORCE ROW LEVEL SECURITY;

CREATE POLICY field_policy_tenant_isolation ON field_policy
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
