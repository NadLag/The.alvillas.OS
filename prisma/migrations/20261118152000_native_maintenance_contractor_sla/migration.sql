BEGIN;

CREATE TABLE maintenance_contractor_assignment (
    id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
    organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    task_id uuid NOT NULL,
    contractor_id uuid,
    rule_id uuid,
    actor_id uuid NOT NULL,
    revision integer NOT NULL,
    idempotency_key uuid NOT NULL,
    priority varchar(12),
    response_due_at timestamptz(6),
    completion_due_at timestamptz(6),
    reason varchar(1000) NOT NULL,
    request_hash char(64) NOT NULL,
    created_at timestamptz(6) NOT NULL DEFAULT now(),
    CONSTRAINT maintenance_contractor_task_fk FOREIGN KEY (organization_id, task_id) REFERENCES maintenance_work_order(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT maintenance_contractor_supplier_fk FOREIGN KEY (organization_id, contractor_id) REFERENCES supplier(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT maintenance_contractor_policy_fk FOREIGN KEY (organization_id, rule_id) REFERENCES config_rule(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT maintenance_contractor_actor_fk FOREIGN KEY (organization_id, actor_id) REFERENCES user_account(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT maintenance_contractor_version_check CHECK (revision > 0 AND length(btrim(reason)) >= 6 AND request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT maintenance_contractor_sla_check CHECK (
        (contractor_id IS NULL AND num_nonnulls(rule_id, priority, response_due_at, completion_due_at) = 0)
        OR (contractor_id IS NOT NULL AND num_nonnulls(rule_id, priority, response_due_at, completion_due_at) = 4
            AND priority IN ('LOW','NORMAL','HIGH','URGENT') AND response_due_at > created_at AND completion_due_at >= response_due_at)
    )
);

CREATE UNIQUE INDEX maintenance_contractor_task_revision ON maintenance_contractor_assignment(organization_id, task_id, revision DESC);
CREATE UNIQUE INDEX maintenance_contractor_actor_nonce ON maintenance_contractor_assignment(organization_id, actor_id, idempotency_key);

ALTER TABLE maintenance_contractor_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_contractor_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_contractor_assignment_tenant_isolation ON maintenance_contractor_assignment
    USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
CREATE TRIGGER maintenance_contractor_immutable BEFORE UPDATE OR DELETE ON maintenance_contractor_assignment
    FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_maintenance_contractor_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE task operation_task; config config_rule; policy jsonb;
BEGIN
    SELECT * INTO task FROM operation_task WHERE organization_id = NEW.organization_id AND id = NEW.task_id;
    IF task.id IS NULL OR task.archived_at IS NOT NULL OR task.type <> 'MAINTENANCE'
        OR task.state IN ('COMPLETED','CANCELLED','SKIPPED')
        OR NEW.revision <> (SELECT coalesce(max(a.revision), 0) + 1 FROM maintenance_contractor_assignment a
            WHERE a.organization_id = NEW.organization_id AND a.task_id = NEW.task_id)
    THEN RAISE EXCEPTION 'maintenance_contractor_requires_open_native_work'; END IF;
    IF NEW.contractor_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO config FROM config_rule WHERE organization_id = NEW.organization_id AND id = NEW.rule_id;
    policy := config.value->'priorities'->NEW.priority;
    IF NOT EXISTS (SELECT 1 FROM supplier s WHERE s.organization_id = NEW.organization_id AND s.id = NEW.contractor_id AND s.archived_at IS NULL)
        OR NEW.priority IS DISTINCT FROM task.priority
        OR config.key IS DISTINCT FROM 'ops.maintenance_sla' OR config.archived_at IS NOT NULL
        OR config.lifecycle NOT IN ('ACTIVE','RETIRED') OR config.effective_from > NEW.created_at
        OR (config.effective_to IS NOT NULL AND config.effective_to <= NEW.created_at)
        OR NEW.response_due_at IS DISTINCT FROM NEW.created_at + make_interval(mins => (policy->>'response_minutes')::integer)
        OR NEW.completion_due_at IS DISTINCT FROM NEW.created_at + make_interval(mins => (policy->>'completion_minutes')::integer)
    THEN RAISE EXCEPTION 'maintenance_contractor_requires_original_supplier_and_policy'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER maintenance_contractor_guard BEFORE INSERT ON maintenance_contractor_assignment
    FOR EACH ROW EXECUTE FUNCTION app_maintenance_contractor_guard();

CREATE FUNCTION app_maintenance_contractor_audit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM audit_log a JOIN operation_task t ON t.organization_id = NEW.organization_id AND t.id = NEW.task_id
        WHERE a.organization_id = NEW.organization_id AND a.actor_id = NEW.actor_id AND a.resource_id = NEW.task_id
          AND a.property_scope_id = t.property_id AND a.resource_type = 'maintenance_work_order'
          AND a.action = 'maintenance.work_order.contractor_changed' AND a.after->>'assignmentId' = NEW.id::text
          AND a.xmin = (SELECT n.xmin FROM maintenance_contractor_assignment n WHERE n.organization_id = NEW.organization_id AND n.id = NEW.id)
    ) THEN RAISE EXCEPTION 'maintenance_contractor_requires_audit'; END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER maintenance_contractor_requires_audit AFTER INSERT ON maintenance_contractor_assignment
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_maintenance_contractor_audit_guard();

COMMIT;
