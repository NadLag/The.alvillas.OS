CREATE TABLE reservation (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  reference text NOT NULL,
  source text NOT NULL,
  external_id text,
  status text NOT NULL DEFAULT 'CONFIRMED',
  guest_name text NOT NULL,
  guest_email text,
  check_in date NOT NULL,
  check_out date NOT NULL,
  nights integer NOT NULL,
  adult_count integer NOT NULL DEFAULT 1,
  child_count integer NOT NULL DEFAULT 0,
  notes text,
  idempotency_key text NOT NULL,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_dates_check CHECK (check_out > check_in),
  CONSTRAINT reservation_counts_check CHECK (nights > 0 AND adult_count >= 0 AND child_count >= 0),
  CONSTRAINT reservation_source_check CHECK (source IN ('MANUAL', 'DIRECT', 'AGENCY', 'AIRBNB', 'BOOKING', 'VRBO')),
  CONSTRAINT reservation_status_check CHECK (
    status IN (
      'IMPORTED',
      'CONFIRMED',
      'GUEST_PREPARATION',
      'CHECKED_IN',
      'STAYING',
      'CHECKED_OUT',
      'FINANCIAL_RECONCILIATION',
      'CLOSED',
      'CANCELLED',
      'NO_SHOW'
    )
  ),
  CONSTRAINT reservation_guest_email_lowercase_check CHECK (guest_email IS NULL OR guest_email = lower(guest_email))
);

CREATE UNIQUE INDEX reservation_org_reference_unique
  ON reservation (organization_id, reference);

CREATE UNIQUE INDEX reservation_org_idempotency_unique
  ON reservation (organization_id, idempotency_key);

CREATE INDEX reservation_org_property_dates_idx
  ON reservation (organization_id, property_id, check_in, check_out);

CREATE INDEX reservation_org_source_external_idx
  ON reservation (organization_id, source, external_id);

CREATE UNIQUE INDEX reservation_org_property_source_external_unique
  ON reservation (organization_id, property_id, source, external_id);

CREATE TABLE reservation_conflict (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES reservation(id) ON DELETE RESTRICT,
  conflicting_reservation_id uuid NOT NULL REFERENCES reservation(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_conflict_distinct_check CHECK (reservation_id <> conflicting_reservation_id),
  CONSTRAINT reservation_conflict_status_check CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED'))
);

CREATE UNIQUE INDEX reservation_conflict_pair_unique
  ON reservation_conflict (organization_id, reservation_id, conflicting_reservation_id);

CREATE INDEX reservation_conflict_org_property_status_idx
  ON reservation_conflict (organization_id, property_id, status);

CREATE TABLE operation_task (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  reservation_id uuid REFERENCES reservation(id) ON DELETE RESTRICT,
  type text NOT NULL,
  state text NOT NULL DEFAULT 'PLANNED',
  priority text NOT NULL DEFAULT 'NORMAL',
  due_date date NOT NULL,
  title_translations jsonb NOT NULL,
  idempotency_key text NOT NULL,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_task_state_check CHECK (
    state IN ('PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'CANCELLED', 'BLOCKED')
  ),
  CONSTRAINT operation_task_priority_check CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT operation_task_title_translations_check CHECK (jsonb_typeof(title_translations) = 'object')
);

CREATE UNIQUE INDEX operation_task_org_idempotency_unique
  ON operation_task (organization_id, idempotency_key);

CREATE INDEX operation_task_org_due_state_idx
  ON operation_task (organization_id, due_date, state);

CREATE INDEX operation_task_org_property_due_idx
  ON operation_task (organization_id, property_id, due_date);

CREATE INDEX operation_task_org_reservation_idx
  ON operation_task (organization_id, reservation_id);

ALTER TABLE reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation FORCE ROW LEVEL SECURITY;
ALTER TABLE reservation_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_conflict FORCE ROW LEVEL SECURITY;
ALTER TABLE operation_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_task FORCE ROW LEVEL SECURITY;

CREATE POLICY reservation_tenant_isolation ON reservation
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY reservation_conflict_tenant_isolation ON reservation_conflict
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY operation_task_tenant_isolation ON operation_task
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
