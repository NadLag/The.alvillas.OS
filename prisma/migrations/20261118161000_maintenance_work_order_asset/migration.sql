BEGIN;
CREATE TABLE maintenance_work_order_asset (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  task_id uuid NOT NULL,
  asset_id uuid,
  asset_revision_id uuid REFERENCES asset_revision(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  actor_id uuid NOT NULL,
  number integer NOT NULL CHECK (number>0),
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason))>=6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT work_order_asset_task_fk FOREIGN KEY (organization_id,task_id) REFERENCES maintenance_work_order(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_asset_asset_fk FOREIGN KEY (organization_id,asset_id) REFERENCES asset(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT work_order_asset_actor_fk FOREIGN KEY (organization_id,actor_id) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CHECK ((asset_id IS NULL) = (asset_revision_id IS NULL))
);
CREATE UNIQUE INDEX work_order_asset_number ON maintenance_work_order_asset(organization_id, task_id, number DESC);
CREATE UNIQUE INDEX work_order_asset_nonce ON maintenance_work_order_asset(organization_id, actor_id, idempotency_key);
ALTER TABLE maintenance_work_order_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_order_asset FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_work_order_asset_tenant_isolation ON maintenance_work_order_asset
  USING (organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER work_order_asset_immutable BEFORE UPDATE OR DELETE ON maintenance_work_order_asset FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_work_order_asset_admit() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE current_property uuid; previous_number integer; previous_asset uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-work-order:'||NEW.organization_id::text||':'||NEW.task_id::text,0));
  SELECT property_id INTO current_property FROM operation_task WHERE organization_id=NEW.organization_id
    AND id=NEW.task_id AND type='MAINTENANCE' AND archived_at IS NULL;
  SELECT number,asset_id INTO previous_number,previous_asset FROM maintenance_work_order_asset
    WHERE organization_id=NEW.organization_id AND task_id=NEW.task_id ORDER BY number DESC LIMIT 1;
  IF current_property IS NULL OR NEW.number<>coalesce(previous_number,0)+1 OR NEW.asset_id IS NOT DISTINCT FROM previous_asset
  THEN RAISE EXCEPTION 'work_order_asset_requires_next_original_revision'; END IF;
  IF NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM asset a JOIN LATERAL (SELECT id FROM asset_revision WHERE organization_id=a.organization_id
      AND asset_id=a.id ORDER BY number DESC LIMIT 1) r ON TRUE
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.asset_id AND a.property_id=current_property AND r.id=NEW.asset_revision_id)
  THEN RAISE EXCEPTION 'work_order_asset_property_and_revision_must_match'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_order_asset_admit BEFORE INSERT ON maintenance_work_order_asset FOR EACH ROW EXECUTE FUNCTION app_work_order_asset_admit();
CREATE FUNCTION app_work_order_asset_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_log l JOIN operation_task t ON t.organization_id=NEW.organization_id AND t.id=NEW.task_id
    WHERE l.organization_id=NEW.organization_id AND l.actor_id=NEW.actor_id AND l.resource_id=NEW.task_id
      AND l.property_scope_id=t.property_id AND l.resource_type='maintenance_work_order'
      AND l.action='maintenance.work_order.asset_changed' AND l.after->>'recordId'=NEW.id::text
      AND l.xmin=(SELECT a.xmin FROM maintenance_work_order_asset a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.id))
  THEN RAISE EXCEPTION 'work_order_asset_requires_audit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_order_asset_complete AFTER INSERT ON maintenance_work_order_asset DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_work_order_asset_complete();
COMMIT;
