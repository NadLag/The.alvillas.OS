CREATE TABLE reference_sequence (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  prefix text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  width integer NOT NULL DEFAULT 4,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, prefix),
  CONSTRAINT reference_sequence_next_value_positive CHECK (next_value > 0),
  CONSTRAINT reference_sequence_width_range CHECK (width BETWEEN 1 AND 12),
  CONSTRAINT reference_sequence_prefix_format CHECK (prefix ~ '^[A-Z][A-Z0-9_]{1,15}$')
);

ALTER TABLE reference_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_sequence FORCE ROW LEVEL SECURITY;

CREATE POLICY reference_sequence_tenant_isolation ON reference_sequence
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
