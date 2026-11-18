BEGIN;

CREATE TABLE maintenance_work_order_finance (
    id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
    organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    task_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    request_hash char(64) NOT NULL,
    estimate_revision integer,
    expense_id uuid,
    invoice_id uuid,
    source_version integer,
    amount decimal(18,2) NOT NULL,
    currency char(3) NOT NULL REFERENCES currency(code) ON DELETE RESTRICT ON UPDATE NO ACTION,
    reason varchar(1000) NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamptz(6) NOT NULL DEFAULT now(),
    CONSTRAINT maintenance_finance_task_fk FOREIGN KEY (organization_id, task_id) REFERENCES maintenance_work_order(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT maintenance_finance_actor_fk FOREIGN KEY (organization_id, actor_id) REFERENCES user_account(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT maintenance_finance_expense_fk FOREIGN KEY (organization_id, expense_id) REFERENCES expense(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT maintenance_finance_invoice_fk FOREIGN KEY (organization_id, invoice_id) REFERENCES supplier_invoice(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT maintenance_finance_source_check CHECK (
        num_nonnulls(estimate_revision, expense_id, invoice_id) = 1
        AND ((estimate_revision IS NOT NULL AND estimate_revision > 0 AND source_version IS NULL AND amount > 0)
            OR (estimate_revision IS NULL AND source_version IS NOT NULL AND source_version >= 0))
    ),
    CONSTRAINT maintenance_finance_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object' AND request_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX maintenance_finance_org_id ON maintenance_work_order_finance(organization_id, id);
CREATE UNIQUE INDEX maintenance_finance_actor_nonce ON maintenance_work_order_finance(organization_id, actor_id, idempotency_key);
CREATE UNIQUE INDEX maintenance_finance_estimate_revision ON maintenance_work_order_finance(organization_id, task_id, estimate_revision);
CREATE UNIQUE INDEX maintenance_finance_expense_version ON maintenance_work_order_finance(organization_id, expense_id, source_version);
CREATE UNIQUE INDEX maintenance_finance_invoice_version ON maintenance_work_order_finance(organization_id, invoice_id, source_version);
CREATE INDEX maintenance_finance_history ON maintenance_work_order_finance(organization_id, task_id, id DESC);

ALTER TABLE maintenance_work_order_finance ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_order_finance FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_work_order_finance_tenant_isolation ON maintenance_work_order_finance
    USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
CREATE TRIGGER maintenance_finance_immutable BEFORE UPDATE OR DELETE ON maintenance_work_order_finance
    FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_maintenance_finance_require_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM audit_log a
        JOIN operation_task t ON t.organization_id = NEW.organization_id AND t.id = NEW.task_id
        WHERE a.organization_id = NEW.organization_id AND a.actor_id = NEW.actor_id
          AND a.property_scope_id = t.property_id AND a.resource_type = 'maintenance_work_order'
          AND a.resource_id = NEW.task_id AND a.action = 'maintenance.work_order.finance.recorded'
          AND a.after->>'recordId' = NEW.id::text
          AND a.xmin = (SELECT f.xmin FROM maintenance_work_order_finance f WHERE f.organization_id = NEW.organization_id AND f.id = NEW.id)
    ) THEN
        RAISE EXCEPTION 'maintenance_finance_requires_audit';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER maintenance_finance_requires_audit AFTER INSERT ON maintenance_work_order_finance
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_maintenance_finance_require_audit();

COMMIT;
