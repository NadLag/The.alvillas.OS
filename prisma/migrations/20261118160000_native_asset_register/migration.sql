BEGIN;
CREATE TABLE asset (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  property_id uuid NOT NULL,
  tag varchar(64) NOT NULL CHECK (tag ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT asset_property_tenant_fk FOREIGN KEY (organization_id, property_id) REFERENCES property(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX asset_org_id ON asset(organization_id, id);
CREATE UNIQUE INDEX asset_org_tag ON asset(organization_id, tag);
CREATE INDEX asset_property_index ON asset(organization_id, property_id, id);
CREATE TABLE asset_revision (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  asset_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  actor_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  name varchar(160) NOT NULL CHECK (length(btrim(name)) > 0),
  category varchar(120) NOT NULL CHECK (length(btrim(category)) > 0),
  description varchar(2000) NOT NULL,
  condition varchar(16) NOT NULL CHECK (condition IN ('EXCELLENT','GOOD','FAIR','POOR','UNSERVICEABLE')),
  purchase_on date,
  purchase_amount decimal(18,2),
  currency char(3) REFERENCES currency(code) ON DELETE RESTRICT ON UPDATE NO ACTION,
  warranty_provider varchar(160),
  warranty_reference varchar(120),
  warranty_starts_on date,
  warranty_ends_on date,
  useful_life_months integer CHECK (useful_life_months > 0),
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) >= 6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT asset_revision_asset_tenant_fk FOREIGN KEY (organization_id, asset_id) REFERENCES asset(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT asset_revision_actor_tenant_fk FOREIGN KEY (organization_id, actor_id) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CHECK ((purchase_amount IS NULL) = (currency IS NULL) AND (purchase_amount IS NULL OR (purchase_amount >= 0 AND purchase_on IS NOT NULL))),
  CHECK (warranty_starts_on IS NULL OR (warranty_ends_on IS NOT NULL AND warranty_starts_on <= warranty_ends_on))
);
CREATE UNIQUE INDEX asset_revision_number ON asset_revision(organization_id, asset_id, number DESC);
CREATE UNIQUE INDEX asset_revision_nonce ON asset_revision(organization_id, actor_id, idempotency_key);
ALTER TABLE asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_tenant_isolation ON asset USING (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE asset_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_revision_tenant_isolation ON asset_revision USING (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER asset_immutable BEFORE UPDATE OR DELETE ON asset FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER asset_revision_immutable BEFORE UPDATE OR DELETE ON asset_revision FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

CREATE FUNCTION app_asset_revision_admit() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('asset:'||NEW.organization_id::text||':'||NEW.asset_id::text,0));
  IF NEW.number <> (SELECT coalesce(max(number),0) + 1 FROM asset_revision WHERE organization_id=NEW.organization_id AND asset_id=NEW.asset_id)
    OR NOT EXISTS(SELECT 1 FROM asset a JOIN property p ON p.organization_id=a.organization_id AND p.id=a.property_id
      WHERE a.organization_id=NEW.organization_id AND a.id=NEW.asset_id AND p.archived_at IS NULL)
    OR (NEW.purchase_amount IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM currency c WHERE c.code=NEW.currency AND c.minor_unit<=2 AND NEW.purchase_amount=round(NEW.purchase_amount,c.minor_unit)))
  THEN RAISE EXCEPTION 'asset_revision_requires_current_property_and_exact_cost'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_revision_admit BEFORE INSERT ON asset_revision FOR EACH ROW EXECUTE FUNCTION app_asset_revision_admit();

CREATE FUNCTION app_asset_revision_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_log l
    JOIN asset a ON a.organization_id=NEW.organization_id AND a.id=NEW.asset_id
    WHERE l.organization_id=NEW.organization_id AND l.actor_id=NEW.actor_id AND l.resource_id=a.id
      AND l.resource_type='asset' AND l.property_scope_id=a.property_id AND l.action='asset.revised'
      AND l.after->>'revisionId'=NEW.id::text
      AND l.xmin=(SELECT r.xmin FROM asset_revision r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.id))
  THEN RAISE EXCEPTION 'asset_revision_requires_audit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER asset_revision_complete AFTER INSERT ON asset_revision DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_asset_revision_complete();

CREATE FUNCTION app_asset_root_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM asset_revision WHERE organization_id=NEW.organization_id AND asset_id=NEW.id AND number=1)
  THEN RAISE EXCEPTION 'asset_requires_original_revision'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER asset_root_complete AFTER INSERT ON asset DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app_asset_root_complete();

DO $$
DECLARE oid uuid;
BEGIN
  FOR oid IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_organization_id',oid::text,true);
    INSERT INTO permission(organization_id,key,resource,action,description,updated_at)
    SELECT oid, resource||':'||verb, resource, verb, verb||' '||replace(resource,'_',' '),now()
    FROM unnest(ARRAY['asset','asset_cost']) resource
    CROSS JOIN unnest(ARRAY['view','create','edit','void','approve','reject','assign','validate','export','pay','reconcile','configure','override']) verb
    ON CONFLICT (organization_id,key) DO NOTHING;
    INSERT INTO role_permission(organization_id,role_id,permission_id)
    SELECT oid,r.id,p.id FROM role r JOIN permission p ON p.organization_id=r.organization_id
     WHERE r.organization_id=oid AND r.is_system AND r.archived_at IS NULL AND (
       (r.key='admin' AND p.resource IN ('asset','asset_cost')) OR
       (r.key IN ('operations_manager','property_manager','regional_manager') AND p.key IN ('asset:view','asset:create','asset:edit')) OR
       (r.key IN ('finance','accountant') AND p.key IN ('asset:view','asset_cost:view'))
     ) ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_organization_id','',true);
END $$;
CREATE OR REPLACE FUNCTION app_maintenance_issue_source_fingerprint(org_uuid uuid,issue_uuid uuid,kind_text text,provider_text text,source_uuid uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE issue operation_issue;task operation_task;property property;source_body jsonb;
BEGIN
 IF org_uuid IS DISTINCT FROM NULLIF(current_setting('app.current_organization_id',true),'')::uuid THEN RETURN NULL;END IF;
 SELECT * INTO issue FROM operation_issue i WHERE i.organization_id=org_uuid AND i.id=issue_uuid;
 SELECT * INTO task FROM operation_task t WHERE t.organization_id=org_uuid AND t.id=issue.task_id AND t.property_id=issue.property_id AND t.archived_at IS NULL;
 SELECT * INTO property FROM property p WHERE p.organization_id=org_uuid AND p.id=issue.property_id AND p.archived_at IS NULL;
 IF issue.id IS NULL OR task.id IS NULL OR property.id IS NULL THEN RETURN NULL;END IF;
 IF kind_text IN('PROPERTY','RESERVATION','GUEST','TASK','PERSON','SUPPLIER','EXPENSE','ASSET') AND provider_text IS NOT NULL THEN RETURN NULL;END IF;
 CASE kind_text
  WHEN 'PROPERTY' THEN SELECT to_jsonb(p) INTO source_body FROM property p WHERE p.organization_id=org_uuid AND p.id=source_uuid AND p.id=issue.property_id AND p.archived_at IS NULL;
  WHEN 'RESERVATION' THEN SELECT to_jsonb(r) INTO source_body FROM reservation r WHERE r.organization_id=org_uuid AND r.id=source_uuid AND r.property_id=issue.property_id AND r.archived_at IS NULL;
  WHEN 'GUEST' THEN SELECT to_jsonb(g) INTO source_body FROM guest g WHERE g.organization_id=org_uuid AND g.id=source_uuid AND g.archived_at IS NULL AND g.merged_into_id IS NULL;
  WHEN 'TASK' THEN SELECT to_jsonb(t) INTO source_body FROM operation_task t WHERE t.organization_id=org_uuid AND t.id=source_uuid AND t.property_id=issue.property_id AND t.archived_at IS NULL;
  WHEN 'PERSON' THEN SELECT to_jsonb(p) INTO source_body FROM person p WHERE p.organization_id=org_uuid AND p.id=source_uuid AND p.archived_at IS NULL;
  WHEN 'SUPPLIER' THEN SELECT to_jsonb(s) INTO source_body FROM supplier s WHERE s.organization_id=org_uuid AND s.id=source_uuid AND s.archived_at IS NULL;
  WHEN 'EXPENSE' THEN SELECT to_jsonb(e) INTO source_body FROM expense e WHERE e.organization_id=org_uuid AND e.id=source_uuid AND e.property_id=issue.property_id;
  WHEN 'ASSET' THEN
   SELECT jsonb_build_object('asset',to_jsonb(a),'revisionId',r.id) INTO source_body FROM asset a
   JOIN LATERAL (SELECT id FROM asset_revision r WHERE r.organization_id=a.organization_id AND r.asset_id=a.id ORDER BY r.number DESC LIMIT 1) r ON TRUE
   WHERE a.organization_id=org_uuid AND a.id=source_uuid AND a.property_id=issue.property_id;
  WHEN 'PHOTO','DOCUMENT' THEN
   IF kind_text='PHOTO' AND provider_text='FIELD_EVIDENCE' THEN
    SELECT jsonb_build_object('evidence',to_jsonb(e),'task',to_jsonb(t)) INTO source_body FROM operation_task_evidence e
     JOIN operation_task t ON t.organization_id=e.organization_id AND t.id=e.task_id
     WHERE e.organization_id=org_uuid AND e.id=source_uuid AND t.property_id=issue.property_id AND t.archived_at IS NULL
      AND e.storage_key IS NOT NULL AND e.sha256 IS NOT NULL AND e.content_type IN('image/png','image/jpeg','image/webp');
   ELSIF provider_text='DOCUMENT_VERSION' THEN
    SELECT jsonb_build_object('version',to_jsonb(v),'root',to_jsonb(d),'admission',to_jsonb(a)) INTO source_body FROM document_version v
     JOIN document d ON d.organization_id=v.organization_id AND d.id=v.document_id
     JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
     WHERE v.organization_id=org_uuid AND v.id=source_uuid AND(kind_text='DOCUMENT' AND d.kind IN('FILE','INSTANCE') OR kind_text='PHOTO' AND d.kind='FILE') AND d.archived_at IS NULL
      AND(d.property_id IS NULL OR d.property_id=issue.property_id)
      AND(d.reservation_id IS NULL OR EXISTS(SELECT 1 FROM reservation r WHERE r.organization_id=org_uuid AND r.id=d.reservation_id AND r.property_id=issue.property_id))
      AND(kind_text='DOCUMENT' OR a.content_type IN('image/png','image/jpeg','image/webp'));
   ELSE RETURN NULL;END IF;
  ELSE RETURN NULL;
 END CASE;
 IF source_body IS NULL THEN RETURN NULL;END IF;
 RETURN encode(digest(convert_to(jsonb_build_object('issue',to_jsonb(issue),'task',to_jsonb(task),'property',to_jsonb(property),'source',source_body)::text,'UTF8'),'sha256'),'hex');
END $$;

COMMIT;
