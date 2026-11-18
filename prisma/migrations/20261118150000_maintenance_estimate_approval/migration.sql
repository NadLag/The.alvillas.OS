BEGIN;

ALTER TABLE approval_request ADD COLUMN maintenance_estimate_id uuid;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_maintenance_estimate_fk
    FOREIGN KEY (organization_id, maintenance_estimate_id) REFERENCES maintenance_work_order_finance(organization_id, id)
    ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX approval_request_maintenance_estimate_unique ON approval_request(organization_id, maintenance_estimate_id);
ALTER TABLE approval_request ADD CONSTRAINT approval_request_maintenance_no_other_source CHECK (
    maintenance_estimate_id IS NULL OR (property_id IS NOT NULL AND num_nonnulls(expense_id, invoice_submission_id, employee_submission_id) = 0)
);

CREATE OR REPLACE FUNCTION app_financial_approval_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'financial approval stages cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'PENDING' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_reason IS NOT NULL THEN RAISE EXCEPTION 'approval stages start pending'; END IF;
  IF NOT EXISTS (SELECT 1 FROM approval_request a JOIN expense e ON e.organization_id=a.organization_id AND e.id=a.expense_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND e.state='PENDING_APPROVAL' AND e.currency=NEW.currency)
  AND NOT EXISTS (SELECT 1 FROM approval_request a
    JOIN supplier_invoice_submission s ON s.organization_id=a.organization_id AND s.id=a.invoice_submission_id
    JOIN supplier_invoice i ON i.organization_id=s.organization_id AND i.id=s.invoice_id AND i.current_submission_id=s.id AND i.current_revision_id=s.revision_id
    JOIN supplier_invoice_revision r ON r.organization_id=s.organization_id AND r.id=s.revision_id AND r.invoice_id=i.id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND i.state='PENDING_APPROVAL' AND r.currency=NEW.currency)
  AND NOT EXISTS(SELECT 1 FROM approval_request a JOIN employee_compensation_submission s ON s.organization_id=a.organization_id AND s.id=a.employee_submission_id
    JOIN employee_compensation_run r ON r.organization_id=s.organization_id AND r.id=s.run_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND a.state='PENDING' AND r.currency=NEW.currency
    AND NOT EXISTS(SELECT 1 FROM employee_compensation_withdrawal w WHERE w.organization_id=s.organization_id AND w.submission_id=s.id))
  AND NOT EXISTS (SELECT 1 FROM approval_request a JOIN maintenance_work_order_finance e
    ON e.organization_id=a.organization_id AND e.id=a.maintenance_estimate_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_id AND a.state='PENDING'
      AND e.estimate_revision IS NOT NULL AND e.currency=NEW.currency)
  THEN RAISE EXCEPTION 'financial approval stage requires its original submitted source'; END IF;
 ELSE
  IF ROW(NEW.organization_id,NEW.id,NEW.approval_id,NEW.position,NEW.kind,NEW.owner_id,NEW.amount,NEW.currency,NEW.routing_snapshot)
   IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.approval_id,OLD.position,OLD.kind,OLD.owner_id,OLD.amount,OLD.currency,OLD.routing_snapshot)
   OR OLD.state<>'PENDING' OR NEW.state NOT IN ('APPROVED','REJECTED','CANCELLED')
   OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR NEW.decision_reason IS NULL OR length(trim(NEW.decision_reason))<6
  THEN RAISE EXCEPTION 'financial approval decisions are immutable and require attribution'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app_maintenance_estimate_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE estimate maintenance_work_order_finance; source_property uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.maintenance_estimate_id IS NOT NULL THEN RAISE EXCEPTION 'maintenance_estimate_approval_is_retained'; END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.maintenance_estimate_id IS DISTINCT FROM OLD.maintenance_estimate_id THEN
        RAISE EXCEPTION 'maintenance_estimate_approval_source_is_immutable';
    END IF;
    IF NEW.maintenance_estimate_id IS NULL THEN RETURN NEW; END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT * INTO estimate FROM maintenance_work_order_finance
            WHERE organization_id = NEW.organization_id AND id = NEW.maintenance_estimate_id;
        SELECT property_id INTO source_property FROM operation_task
            WHERE organization_id = NEW.organization_id AND id = estimate.task_id AND archived_at IS NULL;
        IF estimate.estimate_revision IS NULL OR source_property IS DISTINCT FROM NEW.property_id
            OR estimate.actor_id IS DISTINCT FROM NEW.requested_by OR NEW.state <> 'PENDING'
            OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_reason IS NOT NULL
            OR NEW.routing_snapshot IS DISTINCT FROM estimate.snapshot#>'{policy,stages,0,routing}'
        THEN RAISE EXCEPTION 'maintenance_approval_requires_its_original_estimate'; END IF;
    ELSE
        IF ROW(NEW.id, NEW.organization_id, NEW.property_id, NEW.requested_by, NEW.title, NEW.details, NEW.routing_snapshot, NEW.idempotency_key, NEW.created_at)
            IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.property_id, OLD.requested_by, OLD.title, OLD.details, OLD.routing_snapshot, OLD.idempotency_key, OLD.created_at)
        THEN RAISE EXCEPTION 'maintenance_approval_original_request_is_immutable'; END IF;
        IF ROW(NEW.state, NEW.decided_by, NEW.decided_at, NEW.decision_reason)
            IS DISTINCT FROM ROW(OLD.state, OLD.decided_by, OLD.decided_at, OLD.decision_reason)
            AND (OLD.state <> 'PENDING' OR NEW.state NOT IN ('APPROVED', 'REJECTED')
                OR NOT EXISTS (SELECT 1 FROM approval_stage s WHERE s.organization_id = NEW.organization_id AND s.approval_id = NEW.id
                    AND s.state = NEW.state AND s.decided_by = NEW.decided_by AND s.decided_at = NEW.decided_at AND s.decision_reason = NEW.decision_reason)
                OR EXISTS (SELECT 1 FROM approval_stage s WHERE s.organization_id = NEW.organization_id AND s.approval_id = NEW.id
                    AND (s.state = 'PENDING' OR (NEW.state = 'APPROVED' AND s.state <> 'APPROVED'))))
        THEN RAISE EXCEPTION 'maintenance_approval_requires_its_ordered_decisions'; END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER maintenance_estimate_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON approval_request
    FOR EACH ROW EXECUTE FUNCTION app_maintenance_estimate_approval_guard();

CREATE FUNCTION app_maintenance_estimate_approval_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE request approval_request; stages jsonb; approval_stage_row approval_stage; expected jsonb;
BEGIN
    IF NEW.estimate_revision IS NULL THEN RETURN NULL; END IF;
    stages := NEW.snapshot#>'{policy,stages}';
    IF jsonb_typeof(stages) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'maintenance_estimate_requires_frozen_policy'; END IF;
    IF jsonb_array_length(stages) = 0 THEN RETURN NULL; END IF;

    SELECT * INTO request FROM approval_request WHERE organization_id = NEW.organization_id AND maintenance_estimate_id = NEW.id;
    IF request.id IS NULL OR (SELECT count(*) FROM approval_stage s WHERE s.organization_id = NEW.organization_id AND s.approval_id = request.id)
        <> jsonb_array_length(stages)
    THEN RAISE EXCEPTION 'maintenance_estimate_requires_shared_approval'; END IF;

    FOR approval_stage_row IN SELECT * FROM approval_stage s WHERE s.organization_id = NEW.organization_id AND s.approval_id = request.id LOOP
        expected := stages->(approval_stage_row.position - 1);
        IF expected IS NULL OR approval_stage_row.kind IS DISTINCT FROM expected->>'kind'
            OR approval_stage_row.owner_id::text IS DISTINCT FROM expected->>'ownerId'
            OR approval_stage_row.currency IS DISTINCT FROM expected->>'currency'
            OR approval_stage_row.amount IS DISTINCT FROM (expected->>'amount')::numeric
            OR approval_stage_row.routing_snapshot IS DISTINCT FROM expected->'routing'
            OR ARRAY(SELECT r.user_account_id::text FROM approval_stage_recipient r
                    WHERE r.organization_id = NEW.organization_id AND r.stage_id = approval_stage_row.id ORDER BY r.user_account_id::text)
                IS DISTINCT FROM ARRAY(SELECT id FROM jsonb_array_elements_text(expected->'recipients') AS x(id) ORDER BY id)
        THEN RAISE EXCEPTION 'maintenance_approval_requires_frozen_stages_and_recipients'; END IF;
    END LOOP;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER maintenance_estimate_approval_complete AFTER INSERT ON maintenance_work_order_finance
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_maintenance_estimate_approval_complete();

CREATE FUNCTION app_maintenance_approval_recipient_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM approval_request a WHERE a.organization_id = OLD.organization_id AND a.id = OLD.approval_id
        AND a.maintenance_estimate_id IS NOT NULL)
    THEN RAISE EXCEPTION 'maintenance_approval_recipients_are_immutable'; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER maintenance_approval_recipient_immutable BEFORE UPDATE OR DELETE ON approval_recipient
    FOR EACH ROW EXECUTE FUNCTION app_maintenance_approval_recipient_immutable();

CREATE FUNCTION app_maintenance_estimate_work_allowed(org uuid, task uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT coalesce((
        SELECT coalesce(a.state = 'APPROVED', jsonb_array_length(f.snapshot#>'{policy,stages}') = 0, false)
        FROM maintenance_work_order_finance f LEFT JOIN approval_request a
            ON a.organization_id = f.organization_id AND a.maintenance_estimate_id = f.id
        WHERE f.organization_id = org AND f.task_id = task AND f.estimate_revision IS NOT NULL
        ORDER BY f.estimate_revision DESC LIMIT 1
    ), true);
$$;

CREATE FUNCTION app_maintenance_task_cost_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.type = 'MAINTENANCE' AND NEW.state IN ('IN_PROGRESS', 'COMPLETED') AND NEW.state IS DISTINCT FROM OLD.state
        AND NOT app_maintenance_estimate_work_allowed(NEW.organization_id, NEW.id)
    THEN RAISE EXCEPTION 'maintenance_task_requires_approved_estimate'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER maintenance_task_cost_guard BEFORE UPDATE OF state ON operation_task
    FOR EACH ROW EXECUTE FUNCTION app_maintenance_task_cost_guard();

CREATE FUNCTION app_maintenance_expense_can_post(org uuid, source uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM maintenance_work_order_finance f JOIN operation_task t
            ON t.organization_id = f.organization_id AND t.id = f.task_id
        WHERE f.organization_id = org AND f.expense_id = source
            AND (t.state <> 'COMPLETED' OR NOT app_maintenance_estimate_work_allowed(f.organization_id, f.task_id))
    );
$$;

CREATE FUNCTION app_maintenance_expense_post_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.state = 'POSTED' AND NEW.state IS DISTINCT FROM OLD.state
        AND NOT app_maintenance_expense_can_post(NEW.organization_id, NEW.id)
    THEN RAISE EXCEPTION 'maintenance_expense_requires_completed_approved_work'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER maintenance_expense_post_guard BEFORE UPDATE OF state ON expense
    FOR EACH ROW EXECUTE FUNCTION app_maintenance_expense_post_guard();


CREATE FUNCTION app_maintenance_cost_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE task operation_task; expense_source expense; invoice_source supplier_invoice; revision supplier_invoice_revision;
BEGIN
    SELECT * INTO task FROM operation_task WHERE organization_id = NEW.organization_id AND id = NEW.task_id;
    IF task.id IS NULL OR task.archived_at IS NOT NULL OR task.type <> 'MAINTENANCE' THEN
        RAISE EXCEPTION 'maintenance_cost_requires_active_native_task';
    END IF;
    IF NEW.expense_id IS NOT NULL THEN
        SELECT * INTO expense_source FROM expense WHERE organization_id = NEW.organization_id AND id = NEW.expense_id;
        IF expense_source.property_id IS DISTINCT FROM task.property_id
            OR (expense_source.reservation_id IS NOT NULL AND expense_source.reservation_id IS DISTINCT FROM task.reservation_id)
            OR NEW.amount IS DISTINCT FROM expense_source.amount OR NEW.currency IS DISTINCT FROM expense_source.currency
            OR NEW.source_version IS DISTINCT FROM expense_source.version
        THEN RAISE EXCEPTION 'maintenance_cost_requires_original_expense_revision'; END IF;
    ELSIF NEW.invoice_id IS NOT NULL THEN
        SELECT * INTO invoice_source FROM supplier_invoice WHERE organization_id = NEW.organization_id AND id = NEW.invoice_id;
        SELECT * INTO revision FROM supplier_invoice_revision WHERE organization_id = NEW.organization_id AND id = invoice_source.current_revision_id;
        IF invoice_source.archived_at IS NOT NULL OR revision.id IS NULL
            OR NEW.amount IS DISTINCT FROM revision.amount OR NEW.currency IS DISTINCT FROM revision.currency
            OR NEW.source_version IS DISTINCT FROM invoice_source.version
            OR NOT EXISTS (SELECT 1 FROM supplier_invoice_line l WHERE l.organization_id = NEW.organization_id AND l.revision_id = revision.id)
            OR EXISTS (SELECT 1 FROM supplier_invoice_line l WHERE l.organization_id = NEW.organization_id AND l.revision_id = revision.id
                AND (l.property_id IS DISTINCT FROM task.property_id OR (l.reservation_id IS NOT NULL AND l.reservation_id IS DISTINCT FROM task.reservation_id)))
        THEN RAISE EXCEPTION 'maintenance_cost_requires_original_invoice_revision'; END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER maintenance_cost_source_guard BEFORE INSERT ON maintenance_work_order_finance
    FOR EACH ROW EXECUTE FUNCTION app_maintenance_cost_source_guard();

COMMIT;
