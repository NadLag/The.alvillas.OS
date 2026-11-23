-- Extend the original ledger. Constant defaults preserve existing physical
-- observations, movement identities and revision streams.
ALTER TABLE inventory_movement
 ADD COLUMN reserved_quantity_delta numeric(65,0) NOT NULL DEFAULT 0,
 ADD COLUMN damaged_quantity_delta numeric(65,0) NOT NULL DEFAULT 0,
 ADD COLUMN movement_group_id uuid,
 ADD COLUMN leg smallint,
 ADD COLUMN reservation_id uuid,
 ADD COLUMN reverses_movement_id uuid,
 ADD COLUMN source_snapshot jsonb;
CREATE UNIQUE INDEX inventory_movement_org_id_key ON inventory_movement(organization_id,id);
CREATE UNIQUE INDEX inventory_movement_group_leg_key ON inventory_movement(organization_id,movement_group_id,leg);
CREATE UNIQUE INDEX inventory_movement_group_stream_key ON inventory_movement(organization_id,movement_group_id,location_id,item_id);
CREATE UNIQUE INDEX inventory_movement_original_reversal_key ON inventory_movement(organization_id,reverses_movement_id);
CREATE INDEX inventory_movement_group_history_idx ON inventory_movement(organization_id,movement_group_id,created_at,id);
CREATE INDEX inventory_movement_reservation_stock_idx ON inventory_movement(organization_id,reservation_id,location_id,item_id);
ALTER TABLE inventory_movement ADD CONSTRAINT inventory_movement_organization_id_reservation_id_fkey
 FOREIGN KEY(organization_id,reservation_id) REFERENCES reservation(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE inventory_movement ADD CONSTRAINT inventory_movement_organization_id_reverses_movement_id_fkey
 FOREIGN KEY(organization_id,reverses_movement_id) REFERENCES inventory_movement(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE inventory_movement DROP CONSTRAINT inventory_movement_shape;
ALTER TABLE inventory_movement ADD CONSTRAINT inventory_movement_shape CHECK(
 (kind='STOCKTAKE_ADJUSTMENT' AND stocktake_id IS NOT NULL AND quantity_delta<>0 AND revision>0
  AND reserved_quantity_delta=0 AND damaged_quantity_delta=0 AND movement_group_id IS NULL AND leg IS NULL
  AND reservation_id IS NULL AND reverses_movement_id IS NULL AND source_snapshot IS NULL)
 OR(kind IN('PURCHASE','TRANSFER','CONSUMPTION','LAUNDRY_SEND','LAUNDRY_RETURN','DAMAGE','LOSS','DISPOSAL','ADJUSTMENT','RESERVATION','RELEASE','REVERSAL')
  AND stocktake_id IS NULL AND movement_group_id IS NOT NULL AND leg BETWEEN 1 AND 2 AND revision>0
  AND(quantity_delta<>0 OR reserved_quantity_delta<>0 OR damaged_quantity_delta<>0)
  AND source_snapshot IS NOT NULL AND jsonb_typeof(source_snapshot)='object' AND((kind='REVERSAL')=(reverses_movement_id IS NOT NULL))));

CREATE OR REPLACE FUNCTION app_inventory_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observation inventory_stocktake; original inventory_movement; current_revision bigint;
 physical numeric; held numeric; damaged numeric; outstanding numeric; q numeric; d numeric;
 expected_physical numeric:=0; expected_reserved numeric:=0; expected_damaged numeric:=0;
 request jsonb; condition text; location_kind text; original_kind text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'inventory movements are append only'; END IF;
 IF NEW.kind='STOCKTAKE_ADJUSTMENT' THEN
  SELECT * INTO observation FROM inventory_stocktake WHERE organization_id=NEW.organization_id AND id=NEW.stocktake_id;
  IF NOT FOUND OR ROW(NEW.location_id,NEW.item_id,NEW.actor_id,NEW.revision)
    IS DISTINCT FROM ROW(observation.location_id,observation.item_id,observation.actor_id,observation.revision)
    OR NEW.quantity_delta<>observation.counted_quantity-observation.expected_quantity
  THEN RAISE EXCEPTION 'inventory movement must match its immutable observation'; END IF;
  RETURN NEW;
 END IF;
 SELECT revision INTO current_revision FROM inventory_stock_cursor WHERE organization_id=NEW.organization_id
  AND location_id=NEW.location_id AND item_id=NEW.item_id FOR UPDATE;
 IF NOT FOUND OR NEW.revision<>current_revision+1 THEN RAISE EXCEPTION 'inventory movement revision conflict'; END IF;
 SELECT COALESCE(sum(quantity_delta),0),COALESCE(sum(reserved_quantity_delta),0),COALESCE(sum(damaged_quantity_delta),0)
  INTO physical,held,damaged FROM inventory_movement WHERE organization_id=NEW.organization_id AND location_id=NEW.location_id AND item_id=NEW.item_id;
 IF NOT EXISTS(SELECT 1 FROM inventory_item i JOIN inventory_location l ON l.organization_id=i.organization_id
   WHERE i.organization_id=NEW.organization_id AND i.id=NEW.item_id AND l.id=NEW.location_id
    AND i.archived_at IS NULL AND l.archived_at IS NULL
    AND NEW.source_snapshot#>>'{item,id}'=i.id::text AND NEW.source_snapshot#>>'{item,key}'=i.key
    AND NEW.source_snapshot#>>'{item,category}'=i.category AND NEW.source_snapshot#>>'{item,unit}' IS NOT DISTINCT FROM i.unit
    AND NEW.source_snapshot#>>'{location,id}'=l.id::text AND NEW.source_snapshot#>>'{location,kind}'=l.kind
    AND NEW.source_snapshot#>>'{location,propertyId}' IS NOT DISTINCT FROM l.property_id::text)
 THEN RAISE EXCEPTION 'inventory movement original sources required';END IF;
 IF NEW.source_snapshot#>>'{before,quantity}' IS DISTINCT FROM physical::text
  OR NEW.source_snapshot#>>'{before,reserved}' IS DISTINCT FROM held::text
  OR NEW.source_snapshot#>>'{before,damaged}' IS DISTINCT FROM damaged::text
  OR NEW.source_snapshot#>>'{before,revision}' IS DISTINCT FROM current_revision::text
 THEN RAISE EXCEPTION 'inventory movement original position changed';END IF;
 request:=NEW.source_snapshot->'request';condition:=COALESCE(request->>'condition','USABLE');
 IF jsonb_typeof(request) IS DISTINCT FROM 'object' OR request->>'kind' IS DISTINCT FROM NEW.kind OR condition NOT IN('USABLE','DAMAGED')
  OR COALESCE(length(btrim(request->>'reason')),0) NOT BETWEEN 6 AND 500
 THEN RAISE EXCEPTION 'inventory movement original request required';END IF;
 IF NEW.kind='REVERSAL' THEN
  SELECT * INTO original FROM inventory_movement WHERE organization_id=NEW.organization_id AND id=NEW.reverses_movement_id;
  IF NOT FOUND OR original.movement_group_id IS NULL OR original.kind IN('STOCKTAKE_ADJUSTMENT','REVERSAL')
   OR ROW(NEW.location_id,NEW.item_id,NEW.reservation_id,NEW.leg)
    IS DISTINCT FROM ROW(original.location_id,original.item_id,original.reservation_id,original.leg)
   OR request->>'originalGroupId' IS DISTINCT FROM original.movement_group_id::text
  THEN RAISE EXCEPTION 'inventory reversal original movement required';END IF;
  expected_physical:=-original.quantity_delta;expected_reserved:=-original.reserved_quantity_delta;expected_damaged:=-original.damaged_quantity_delta;
  IF physical+expected_physical-held-expected_reserved-damaged-expected_damaged<LEAST(0,physical-held-damaged)
  THEN RAISE EXCEPTION 'inventory reversal would uncover committed stock';END IF;
 ELSE
  IF COALESCE(request->>'quantity','')!~'^[1-9][0-9]{0,39}$' OR request->>'itemId' IS DISTINCT FROM NEW.item_id::text
   OR(request->>'reservationId') IS DISTINCT FROM NEW.reservation_id::text
   OR(CASE WHEN NEW.leg=1 THEN request->>'locationId' ELSE request->>'destinationLocationId' END) IS DISTINCT FROM NEW.location_id::text
  THEN RAISE EXCEPTION 'inventory movement original dimensions required';END IF;
  q:=(request->>'quantity')::numeric;
  CASE NEW.kind
   WHEN 'PURCHASE' THEN expected_physical:=q;
   WHEN 'TRANSFER','LAUNDRY_SEND','LAUNDRY_RETURN' THEN
    d:=CASE WHEN NEW.leg=1 THEN -q ELSE q END;expected_physical:=d;
    IF condition='DAMAGED' THEN expected_damaged:=d;END IF;
    IF NEW.leg=1 AND condition='USABLE' AND physical-held-damaged<q THEN RAISE EXCEPTION 'inventory available stock insufficient';END IF;
    IF NEW.kind<>'TRANSFER' AND NOT EXISTS(SELECT 1 FROM inventory_item WHERE organization_id=NEW.organization_id AND id=NEW.item_id AND category='LINEN')
    THEN RAISE EXCEPTION 'laundry requires original linen item';END IF;
    SELECT kind INTO location_kind FROM inventory_location WHERE organization_id=NEW.organization_id AND id=NEW.location_id;
    IF NEW.kind='LAUNDRY_SEND' AND(NEW.leg=1 AND location_kind NOT IN('PROPERTY','STORE','IN_TRANSIT') OR NEW.leg=2 AND location_kind NOT IN('LAUNDRY','IN_TRANSIT'))
     OR NEW.kind='LAUNDRY_RETURN' AND(NEW.leg=1 AND location_kind NOT IN('LAUNDRY','IN_TRANSIT') OR NEW.leg=2 AND location_kind NOT IN('PROPERTY','STORE','IN_TRANSIT'))
    THEN RAISE EXCEPTION 'laundry original location flow required';END IF;
   WHEN 'CONSUMPTION' THEN
    expected_physical:=-q;IF NEW.reservation_id IS NOT NULL THEN expected_reserved:=-q;
    ELSIF physical-held-damaged<q THEN RAISE EXCEPTION 'inventory available stock insufficient';END IF;
   WHEN 'DAMAGE' THEN expected_damaged:=q;
   WHEN 'LOSS','DISPOSAL' THEN expected_physical:=-q;IF condition='DAMAGED' THEN expected_damaged:=-q;END IF;
   WHEN 'ADJUSTMENT' THEN
    IF COALESCE(request->>'direction','') NOT IN('ADD','REMOVE') THEN RAISE EXCEPTION 'inventory adjustment direction required';END IF;
    d:=CASE WHEN request->>'direction'='ADD' THEN q ELSE -q END;expected_physical:=d;
    IF condition='DAMAGED' THEN expected_damaged:=d;END IF;
   WHEN 'RESERVATION' THEN
    IF physical-held-damaged<q THEN RAISE EXCEPTION 'inventory available stock insufficient';END IF;
    IF NOT EXISTS(SELECT 1 FROM reservation WHERE organization_id=NEW.organization_id AND id=NEW.reservation_id
      AND archived_at IS NULL AND status NOT IN('CANCELLED','NO_SHOW','CLOSED'))
    THEN RAISE EXCEPTION 'inventory active reservation required';END IF;
    expected_reserved:=q;
   WHEN 'RELEASE' THEN expected_reserved:=-q;
   ELSE RAISE EXCEPTION 'inventory movement kind invalid';
  END CASE;
  IF NEW.kind IN('RESERVATION','RELEASE') AND NEW.reservation_id IS NULL
   OR NEW.kind NOT IN('RESERVATION','RELEASE','CONSUMPTION') AND NEW.reservation_id IS NOT NULL
  THEN RAISE EXCEPTION 'inventory reservation binding invalid';END IF;
 END IF;
 IF NEW.reservation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reservation r JOIN inventory_location l ON l.organization_id=r.organization_id
  WHERE r.organization_id=NEW.organization_id AND r.id=NEW.reservation_id AND l.id=NEW.location_id
   AND(l.property_id IS NULL OR l.property_id=r.property_id))
 THEN RAISE EXCEPTION 'inventory original reservation location required';END IF;
 IF expected_reserved<0 THEN
  SELECT COALESCE(sum(reserved_quantity_delta),0) INTO outstanding FROM inventory_movement
   WHERE organization_id=NEW.organization_id AND location_id=NEW.location_id AND item_id=NEW.item_id AND reservation_id=NEW.reservation_id;
  IF outstanding+expected_reserved<0 THEN RAISE EXCEPTION 'inventory original reservation stock insufficient';END IF;
 END IF;
 IF ROW(NEW.quantity_delta,NEW.reserved_quantity_delta,NEW.damaged_quantity_delta)
  IS DISTINCT FROM ROW(expected_physical,expected_reserved,expected_damaged)
 THEN RAISE EXCEPTION 'inventory movement exact deltas required';END IF;
 IF physical+expected_physical<0 OR held+expected_reserved<0 OR damaged+expected_damaged<0
  OR damaged+expected_damaged-physical-expected_physical>GREATEST(0,damaged-physical)
 THEN RAISE EXCEPTION 'inventory stock dimensions insufficient';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_inventory_cursor_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_stocktake WHERE organization_id=NEW.organization_id
   AND location_id=NEW.location_id AND item_id=NEW.item_id AND revision=NEW.revision)
  AND NOT EXISTS(SELECT 1 FROM inventory_movement WHERE organization_id=NEW.organization_id
   AND location_id=NEW.location_id AND item_id=NEW.item_id AND revision=NEW.revision AND movement_group_id IS NOT NULL)
 THEN RAISE EXCEPTION 'inventory revision requires an immutable observation or attributed movement';END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION app_inventory_movement_group_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt outbox_event; total integer; group_kind text; legs jsonb; original_total integer; receipt_xmin text;
BEGIN
 IF NEW.movement_group_id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO receipt FROM outbox_event WHERE organization_id=NEW.organization_id
  AND type='inventory.movement.recorded' AND idempotency_key='inventory-movement:'||NEW.movement_group_id::text;
 SELECT xmin::text INTO receipt_xmin FROM outbox_event WHERE id=receipt.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR receipt.payload->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
  OR receipt.payload->>'actorId' IS DISTINCT FROM NEW.actor_id::text OR receipt.payload->>'groupId' IS DISTINCT FROM NEW.movement_group_id::text
  OR receipt.payload->>'schemaVersion' IS DISTINCT FROM '1' OR COALESCE(receipt.payload->>'commandHash','')!~'^[a-f0-9]{64}$'
  OR receipt_xmin<>pg_current_xact_id()::xid::text
 THEN RAISE EXCEPTION 'inventory movement original command receipt required';END IF;
 SELECT count(*)::integer,min(kind),jsonb_agg(jsonb_build_object('id',id::text,'locationId',location_id::text,
   'itemId',item_id::text,'quantity',quantity_delta::text,'reserved',reserved_quantity_delta::text,'damaged',damaged_quantity_delta::text,
   'revision',revision::text,'reservationId',reservation_id::text,'reversesMovementId',reverses_movement_id::text,'leg',leg) ORDER BY leg)
  INTO total,group_kind,legs FROM inventory_movement WHERE organization_id=NEW.organization_id AND movement_group_id=NEW.movement_group_id;
 IF total<>(CASE WHEN NEW.kind IN('TRANSFER','LAUNDRY_SEND','LAUNDRY_RETURN') THEN 2 WHEN NEW.kind='REVERSAL' THEN total ELSE 1 END)
  OR total NOT BETWEEN 1 AND 2 OR receipt.payload->'lines' IS DISTINCT FROM legs OR receipt.payload->>'kind' IS DISTINCT FROM group_kind
  OR(legs->0->>'leg') IS DISTINCT FROM '1' OR total=2 AND(legs->1->>'leg') IS DISTINCT FROM '2'
  OR EXISTS(SELECT 1 FROM inventory_movement m WHERE m.organization_id=NEW.organization_id AND m.movement_group_id=NEW.movement_group_id
   AND(m.kind<>NEW.kind OR m.actor_id<>NEW.actor_id OR m.item_id<>NEW.item_id OR m.created_at<>NEW.created_at
    OR m.source_snapshot->'request' IS DISTINCT FROM NEW.source_snapshot->'request' OR m.xmin::text<>pg_current_xact_id()::xid::text))
 THEN RAISE EXCEPTION 'inventory movement original group legs required';END IF;
 IF NEW.kind IN('TRANSFER','LAUNDRY_SEND','LAUNDRY_RETURN') AND EXISTS(
  SELECT 1 FROM inventory_movement WHERE organization_id=NEW.organization_id AND movement_group_id=NEW.movement_group_id
   GROUP BY movement_group_id HAVING sum(quantity_delta)<>0 OR sum(damaged_quantity_delta)<>0 OR sum(reserved_quantity_delta)<>0)
 THEN RAISE EXCEPTION 'inventory paired movements must conserve original stock';END IF;
 IF NEW.kind='REVERSAL' THEN
  SELECT count(*)::integer INTO original_total FROM inventory_movement WHERE organization_id=NEW.organization_id
   AND movement_group_id=(NEW.source_snapshot#>>'{request,originalGroupId}')::uuid;
  IF original_total<>total THEN RAISE EXCEPTION 'inventory reversal must retain every original leg';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM inventory_movement m LEFT JOIN inventory_stock_cursor c ON c.organization_id=m.organization_id
   AND c.location_id=m.location_id AND c.item_id=m.item_id WHERE m.organization_id=NEW.organization_id
   AND m.movement_group_id=NEW.movement_group_id AND(c.revision IS NULL OR c.revision<m.revision))
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='inventory_movement'
    AND a.resource_id=NEW.movement_group_id AND a.actor_id=NEW.actor_id AND a.action='inventory.movement.recorded'
    AND a.after=receipt.payload AND a.reason=NEW.source_snapshot#>>'{request,reason}' AND length(btrim(a.reason)) BETWEEN 6 AND 500
    AND a.occurred_at=NEW.created_at AND receipt.occurred_at=NEW.created_at AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'inventory movement revision and attributed audit must commit together';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_movement_group_complete AFTER INSERT ON inventory_movement
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_inventory_movement_group_complete();

CREATE FUNCTION app_inventory_movement_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type IN('inventory.movement.recorded','inventory.movement.cancelled') THEN RAISE EXCEPTION 'inventory movement receipt is immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF(OLD.type IN('inventory.movement.recorded','inventory.movement.cancelled') OR NEW.type IN('inventory.movement.recorded','inventory.movement.cancelled'))
   AND ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at,NEW.created_at)
  THEN RAISE EXCEPTION 'inventory movement receipt is immutable';END IF;
  RETURN NEW;
 END IF;
 IF NEW.type='inventory.movement.cancelled' AND NOT EXISTS(
  SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='inventory_movement_command'
   AND a.action=NEW.type AND NEW.idempotency_key='inventory-movement:'||a.resource_id::text AND a.after=NEW.payload
   AND NEW.payload=jsonb_build_object('schemaVersion',1,'organizationId',NEW.organization_id::text,'actorId',a.actor_id::text,'idempotencyKey',a.resource_id::text)
   AND a.occurred_at=NEW.occurred_at AND a.xmin::text=pg_current_xact_id()::xid::text
   AND NEW.status='PENDING' AND NEW.attempt_count=0 AND NEW.processed_at IS NULL AND NEW.next_attempt_at IS NULL AND NEW.last_error IS NULL)
 THEN RAISE EXCEPTION 'inventory movement negative receipt requires original audit';END IF;
 IF NEW.type='inventory.movement.recorded' AND(NEW.status<>'PENDING' OR NEW.attempt_count<>0 OR NEW.processed_at IS NOT NULL
  OR NEW.next_attempt_at IS NOT NULL OR NEW.last_error IS NOT NULL OR NOT EXISTS(SELECT 1 FROM inventory_movement m
   WHERE m.organization_id=NEW.organization_id AND NEW.idempotency_key='inventory-movement:'||m.movement_group_id::text
    AND m.movement_group_id::text=NEW.payload->>'groupId' AND m.actor_id::text=NEW.payload->>'actorId'
    AND m.xmin::text=pg_current_xact_id()::xid::text))
 THEN RAISE EXCEPTION 'inventory movement receipt requires original group';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_movement_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event
 FOR EACH ROW EXECUTE FUNCTION app_inventory_movement_receipt_guard();

-- Extend the native permission catalog and its existing administrator template.
-- Ordinary operational roles receive no implicit movement or override authority.
DO $$ DECLARE organization_uuid uuid; BEGIN
 FOR organization_uuid IN SELECT id FROM organization LOOP
  PERFORM set_config('app.current_organization_id',organization_uuid::text,true);
  INSERT INTO permission(organization_id,key,resource,action,description)
  SELECT organization_uuid,'inventory_movement:'||action,'inventory_movement',action,action||' inventory movement'
  FROM unnest(ARRAY['view','create','edit','void','approve','reject','assign','validate','export','pay','reconcile','configure','override']) action
  ON CONFLICT(organization_id,key) DO NOTHING;
  INSERT INTO role_permission(organization_id,role_id,permission_id)
  SELECT organization_uuid,r.id,p.id FROM role r JOIN permission p ON p.organization_id=r.organization_id
  WHERE r.organization_id=organization_uuid AND r.key='admin' AND r.is_system AND r.archived_at IS NULL AND p.resource='inventory_movement'
  ON CONFLICT(organization_id,role_id,permission_id) DO NOTHING;
 END LOOP;
END $$;
