ALTER TABLE operation_task
  ADD COLUMN assigned_to_user_account_id uuid,
  ADD COLUMN assigned_to_person_id uuid,
  ADD COLUMN completed_by_user_account_id uuid,
  ADD COLUMN completed_by_person_id uuid,
  ADD COLUMN completed_at timestamptz;

ALTER TABLE operation_task
  ADD CONSTRAINT operation_task_assigned_to_user_account_id_fkey
    FOREIGN KEY (assigned_to_user_account_id) REFERENCES user_account(id) ON DELETE RESTRICT,
  ADD CONSTRAINT operation_task_assigned_to_person_id_fkey
    FOREIGN KEY (assigned_to_person_id) REFERENCES person(id) ON DELETE RESTRICT,
  ADD CONSTRAINT operation_task_completed_by_user_account_id_fkey
    FOREIGN KEY (completed_by_user_account_id) REFERENCES user_account(id) ON DELETE RESTRICT,
  ADD CONSTRAINT operation_task_completed_by_person_id_fkey
    FOREIGN KEY (completed_by_person_id) REFERENCES person(id) ON DELETE RESTRICT,
  ADD CONSTRAINT operation_task_completed_state_check
    CHECK ((completed_at IS NULL AND completed_by_user_account_id IS NULL AND completed_by_person_id IS NULL) OR state = 'COMPLETED');

CREATE INDEX operation_task_org_assignee_state_due_idx
  ON operation_task (organization_id, assigned_to_user_account_id, state, due_date);

CREATE INDEX operation_task_org_completed_at_idx
  ON operation_task (organization_id, completed_at);

CREATE TABLE operation_task_checklist_item (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL REFERENCES operation_task(id) ON DELETE RESTRICT,
  key text NOT NULL,
  label_translations jsonb NOT NULL,
  sort_order integer NOT NULL,
  completed_at timestamptz,
  completed_by_user_account_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
  completed_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_task_check_label_translations_check CHECK (jsonb_typeof(label_translations) = 'object'),
  CONSTRAINT operation_task_check_sort_order_check CHECK (sort_order >= 0),
  CONSTRAINT operation_task_check_completed_pair_check CHECK (
    (completed_at IS NULL AND completed_by_user_account_id IS NULL AND completed_by_person_id IS NULL)
    OR
    (completed_at IS NOT NULL AND completed_by_user_account_id IS NOT NULL AND completed_by_person_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX operation_task_check_org_task_key_unique
  ON operation_task_checklist_item (organization_id, task_id, key);

CREATE INDEX operation_task_check_org_task_order_idx
  ON operation_task_checklist_item (organization_id, task_id, sort_order);

ALTER TABLE operation_task_checklist_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_task_checklist_item FORCE ROW LEVEL SECURITY;

CREATE POLICY operation_task_checklist_item_tenant_isolation ON operation_task_checklist_item
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
