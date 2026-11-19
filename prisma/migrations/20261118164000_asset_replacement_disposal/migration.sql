BEGIN;

CREATE TABLE asset_lifecycle_event (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  asset_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  kind varchar(12) NOT NULL CHECK (kind IN ('PLAN','CANCEL','REPLACE','DISPOSE')),
  effective_on date,
  successor_id uuid,
  method varchar(12) CHECK (method IN ('SOLD','RECYCLED','DONATED','SCRAPPED','RETURNED','OTHER')),
  reference varchar(160),
  planned_amount decimal(18,2),
  currency char(3) REFERENCES currency(code) ON DELETE RESTRICT ON UPDATE NO ACTION,
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) >= 6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT asset_lifecycle_asset_tenant_fk FOREIGN KEY (organization_id,asset_id) REFERENCES asset(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT asset_lifecycle_successor_tenant_fk FOREIGN KEY (organization_id,successor_id) REFERENCES asset(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT asset_lifecycle_actor_tenant_fk FOREIGN KEY (organization_id,actor_id) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CHECK ((kind='CANCEL') = (effective_on IS NULL)),
  CHECK ((kind='REPLACE') = (successor_id IS NOT NULL) AND asset_id IS DISTINCT FROM successor_id),
  CHECK ((kind='DISPOSE') = (method IS NOT NULL)),
  CHECK (reference IS NULL OR kind='DISPOSE'),
  CHECK ((planned_amount IS NULL) = (currency IS NULL) AND (planned_amount IS NULL OR (kind='PLAN' AND planned_amount>=0)))
);
CREATE UNIQUE INDEX asset_lifecycle_number ON asset_lifecycle_event(organization_id,asset_id,number DESC);
CREATE UNIQUE INDEX asset_lifecycle_nonce ON asset_lifecycle_event(organization_id,actor_id,idempotency_key);
CREATE UNIQUE INDEX asset_lifecycle_successor ON asset_lifecycle_event(organization_id,successor_id);
ALTER TABLE asset_lifecycle_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_lifecycle_event FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_lifecycle_tenant ON asset_lifecycle_event USING (organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid);

CREATE TRIGGER asset_lifecycle_immutable BEFORE UPDATE OR DELETE ON asset_lifecycle_event
FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_asset_lifecycle_admit() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE head asset_lifecycle_event%ROWTYPE;
DECLARE source_property uuid;
DECLARE local_today date;
DECLARE purchase_date date;
DECLARE locked_asset uuid;
BEGIN
  FOR locked_asset IN SELECT DISTINCT u.id FROM unnest(ARRAY[NEW.asset_id,NEW.successor_id]) u(id) WHERE u.id IS NOT NULL ORDER BY u.id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('asset:'||NEW.organization_id::text||':'||locked_asset::text,0));
  END LOOP;
  SELECT a.property_id, timezone(p.timezone,clock_timestamp())::date INTO source_property,local_today
    FROM asset a JOIN property p ON p.organization_id=a.organization_id AND p.id=a.property_id
    WHERE a.organization_id=NEW.organization_id AND a.id=NEW.asset_id AND p.archived_at IS NULL;
  SELECT purchase_on INTO purchase_date FROM asset_revision WHERE organization_id=NEW.organization_id AND asset_id=NEW.asset_id ORDER BY number DESC LIMIT 1;
  SELECT * INTO head FROM asset_lifecycle_event WHERE organization_id=NEW.organization_id AND asset_id=NEW.asset_id ORDER BY number DESC LIMIT 1;
  IF source_property IS NULL OR NEW.number<>coalesce(head.number,0)+1 OR head.kind='DISPOSE'
    OR (head.kind='REPLACE' AND (NEW.kind<>'DISPOSE' OR NEW.effective_on<head.effective_on))
    OR (NEW.kind='CANCEL' AND head.kind IS DISTINCT FROM 'PLAN')
    OR (NEW.kind IN ('REPLACE','DISPOSE') AND (NEW.effective_on>local_today OR NEW.effective_on<purchase_date))
    OR (NEW.kind='REPLACE' AND NOT EXISTS (
      SELECT 1 FROM asset a WHERE a.organization_id=NEW.organization_id AND a.id=NEW.successor_id AND a.property_id=source_property
        AND NOT EXISTS (SELECT 1 FROM asset_lifecycle_event e WHERE e.organization_id=a.organization_id AND e.asset_id=a.id AND e.kind IN ('REPLACE','DISPOSE'))
    ))
    OR (NEW.planned_amount IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM currency WHERE code=NEW.currency AND minor_unit<=2 AND NEW.planned_amount=round(NEW.planned_amount,minor_unit)
    )) THEN RAISE EXCEPTION 'invalid canonical asset lifecycle change'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER asset_lifecycle_admit BEFORE INSERT ON asset_lifecycle_event
FOR EACH ROW EXECUTE FUNCTION app_asset_lifecycle_admit();

CREATE FUNCTION app_asset_lifecycle_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_log l JOIN asset a ON a.organization_id=NEW.organization_id AND a.id=NEW.asset_id
    WHERE l.organization_id=NEW.organization_id AND l.actor_id=NEW.actor_id AND l.resource_id=NEW.asset_id
      AND l.property_scope_id=a.property_id AND l.resource_type='asset' AND l.action='asset.lifecycle_recorded'
      AND l.after->>'eventId'=NEW.id::text
      AND l.xmin=(SELECT e.xmin FROM asset_lifecycle_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.id))
  THEN RAISE EXCEPTION 'asset lifecycle event requires audit'; END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER asset_lifecycle_complete AFTER INSERT ON asset_lifecycle_event DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_asset_lifecycle_complete();

COMMIT;
