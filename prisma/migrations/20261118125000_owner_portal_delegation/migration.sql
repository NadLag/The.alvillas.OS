ALTER TABLE owner_representative
  ADD CONSTRAINT owner_representative_org_owner_id_unique UNIQUE (organization_id, owner_id, id);

ALTER TABLE owner_portal_access
  ADD COLUMN representative_id uuid,
  ADD COLUMN role_assignment_id uuid,
  ADD CONSTRAINT owner_portal_access_representative_fk
    FOREIGN KEY (organization_id, owner_id, representative_id)
    REFERENCES owner_representative (organization_id, owner_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT owner_portal_access_role_assignment_fk
    FOREIGN KEY (organization_id, role_assignment_id)
    REFERENCES role_assignment (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT owner_portal_access_representative_assignment_check
    CHECK (representative_id IS NULL OR role_assignment_id IS NOT NULL);

CREATE VIEW active_owner_portal_access WITH (security_invoker = true, security_barrier = true) AS
SELECT access.organization_id, access.owner_id, access.user_account_id, access.created_at,
  access.representative_id IS NULL AS can_view_finances
FROM owner_portal_access access
JOIN user_account account ON account.organization_id = access.organization_id
  AND account.id = access.user_account_id AND account.status = 'ACTIVE'
JOIN person ON person.organization_id = account.organization_id AND person.id = account.person_id AND person.archived_at IS NULL
JOIN owner ON owner.organization_id = access.organization_id AND owner.id = access.owner_id AND owner.archived_at IS NULL
WHERE access.archived_at IS NULL
  AND (access.role_assignment_id IS NULL OR EXISTS (
    SELECT 1 FROM role_assignment assignment
    JOIN role ON role.organization_id = assignment.organization_id AND role.id = assignment.role_id AND role.archived_at IS NULL
    WHERE assignment.organization_id = access.organization_id AND assignment.id = access.role_assignment_id
      AND assignment.user_account_id = account.id AND assignment.person_id = person.id
      AND assignment.scope_type = 'owner' AND assignment.scope_id = owner.id
      AND role.key = CASE WHEN access.representative_id IS NULL THEN 'owner' ELSE 'owner_representative' END
      AND assignment.archived_at IS NULL AND assignment.valid_from <= statement_timestamp()
      AND (assignment.valid_to IS NULL OR assignment.valid_to > statement_timestamp())
  ))
  AND (access.representative_id IS NULL OR EXISTS (
    SELECT 1 FROM owner_representative representative
    WHERE representative.organization_id = access.organization_id AND representative.owner_id = access.owner_id
      AND representative.id = access.representative_id AND representative.archived_at IS NULL AND representative.status = 'ACTIVE'
      AND lower(representative.email) = lower(account.email)
      AND (representative.valid_from IS NULL OR representative.valid_from <= statement_timestamp())
      AND (representative.valid_to IS NULL OR representative.valid_to > statement_timestamp())
  ));
