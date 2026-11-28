BEGIN;

-- CreateTable
CREATE TABLE "guest_hub_service_order_delegation" (
    "organization_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "catalog_rule_id" UUID NOT NULL,
    "catalog_rule_version" INTEGER NOT NULL,
    "catalog_fingerprint" TEXT NOT NULL,
    "ordering_rule_id" UUID NOT NULL,
    "ordering_rule_version" INTEGER NOT NULL,
    "ordering_snapshot" JSONB NOT NULL,
    "public_offers" JSONB NOT NULL,
    "authorization_cap_fingerprint" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "signature_version" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "guest_service_delegation_pkey" PRIMARY KEY ("organization_id","grant_id")
);

-- CreateTable
CREATE TABLE "guest_hub_service_order_request" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "command_key" UUID NOT NULL,
    "command_hash" TEXT NOT NULL,
    "command_key_version" TEXT NOT NULL,
    "review_fingerprint" TEXT NOT NULL,
    "native_review_fingerprint" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "selection_snapshot" JSONB NOT NULL,
    "notice_snapshot" JSONB NOT NULL,
    "total_amount" DECIMAL(18,2),
    "currency" VARCHAR(3) NOT NULL,
    "requested_locale" TEXT NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6) NOT NULL,
    "review_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "signature_version" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "guest_hub_service_order_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_service_delegation_catalog_idx" ON "guest_hub_service_order_delegation"("organization_id", "catalog_rule_id");

-- CreateIndex
CREATE INDEX "guest_service_delegation_ordering_idx" ON "guest_hub_service_order_delegation"("organization_id", "ordering_rule_id");

-- CreateIndex
CREATE INDEX "guest_service_request_link_history_idx" ON "guest_hub_service_order_request"("organization_id", "link_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "guest_service_request_grant_history_idx" ON "guest_hub_service_order_request"("organization_id", "grant_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_service_request_org_id_key" ON "guest_hub_service_order_request"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_service_request_nonce_key" ON "guest_hub_service_order_request"("organization_id", "link_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "guest_service_request_order_key" ON "guest_hub_service_order_request"("organization_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_service_request_event_key" ON "guest_hub_service_order_request"("organization_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_service_request_outbox_key" ON "guest_hub_service_order_request"("organization_id", "outbox_event_id");

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_delegation" ADD CONSTRAINT "guest_service_delegation_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_delegation" ADD CONSTRAINT "guest_service_delegation_grant_fk" FOREIGN KEY ("organization_id", "grant_id") REFERENCES "guest_hub_form_grant"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_delegation" ADD CONSTRAINT "guest_service_delegation_catalog_fk" FOREIGN KEY ("organization_id", "catalog_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_delegation" ADD CONSTRAINT "guest_service_delegation_ordering_fk" FOREIGN KEY ("organization_id", "ordering_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_request" ADD CONSTRAINT "guest_service_request_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_request" ADD CONSTRAINT "guest_service_request_link_fk" FOREIGN KEY ("organization_id", "link_id") REFERENCES "guest_hub_link"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_request" ADD CONSTRAINT "guest_service_request_grant_fk" FOREIGN KEY ("organization_id", "grant_id") REFERENCES "guest_hub_form_grant"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_request" ADD CONSTRAINT "guest_service_request_delegation_fk" FOREIGN KEY ("organization_id", "grant_id") REFERENCES "guest_hub_service_order_delegation"("organization_id", "grant_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_request" ADD CONSTRAINT "guest_service_request_order_fk" FOREIGN KEY ("organization_id", "order_id") REFERENCES "service_order"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_request" ADD CONSTRAINT "guest_service_request_event_fk" FOREIGN KEY ("organization_id", "event_id") REFERENCES "service_order_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_request" ADD CONSTRAINT "guest_service_request_currency_fk" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "guest_hub_service_order_request" ADD CONSTRAINT "guest_service_request_outbox_fk" FOREIGN KEY ("organization_id", "outbox_event_id") REFERENCES "outbox_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE guest_hub_form_grant DROP CONSTRAINT guest_form_grant_shape;
ALTER TABLE guest_hub_form_grant ADD CONSTRAINT guest_form_grant_shape CHECK(coalesce(
 form_key IN('PROFILE','STAY_DETAILS','IDENTITY_DOCUMENTS','HOUSE_RULES','SERVICE_ORDERS') AND decision IN('GRANTED','WITHDRAWN') AND version>0 AND ((version=1)=(previous_id IS NULL))
 AND isfinite(created_at) AND isfinite(expires_at) AND created_at=date_trunc('milliseconds',created_at) AND expires_at=date_trunc('milliseconds',expires_at)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND link_token_hash ~ '^[a-f0-9]{64}$' AND signature ~ '^[a-f0-9]{64}$' AND length(signature_version) BETWEEN 1 AND 120
 AND length(btrim(reason)) BETWEEN 1 AND 1000 AND length(request_id) BETWEEN 1 AND 200
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object'
 AND jsonb_typeof(authorization_cap)='object' AND authorization_cap->>'schemaVersion'='1'
 AND authorization_cap->>'organizationId'=organization_id::text AND authorization_cap->>'userAccountId'=created_by::text
 AND (decision='WITHDRAWN' AND policy_id IS NULL AND policy_version IS NULL AND policy_fingerprint IS NULL AND policy_snapshot='{}'::jsonb
  OR decision='GRANTED' AND expires_at>created_at AND policy_id IS NOT NULL AND policy_version>0 AND policy_fingerprint ~ '^[a-f0-9]{64}$'
   AND policy_snapshot->>'id'=policy_id::text AND policy_snapshot->>'version'=policy_version::text
   AND policy_snapshot-ARRAY['id','version','value']='{}'::jsonb AND jsonb_typeof(policy_snapshot->'value')='object')
 ,false));

CREATE OR REPLACE FUNCTION app_guest_form_actual_policy(org UUID,policy_id UUID,policy_version INTEGER,snapshot JSONB,res UUID,prop UUID,at_time TIMESTAMPTZ,form_key TEXT) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE;r reservation%ROWTYPE;p property%ROWTYPE;
BEGIN
 SELECT * INTO rule FROM config_rule WHERE organization_id=org AND id=policy_id FOR SHARE;
 SELECT * INTO r FROM reservation WHERE organization_id=org AND id=res;
 SELECT * INTO p FROM property WHERE organization_id=org AND id=prop;
 RETURN coalesce(rule.id IS NOT NULL AND form_key IN('PROFILE','STAY_DETAILS','IDENTITY_DOCUMENTS','HOUSE_RULES','SERVICE_ORDERS') AND rule.key=CASE form_key WHEN 'PROFILE' THEN 'guest_hub.profile' WHEN 'STAY_DETAILS' THEN 'guest_hub.stay_details' WHEN 'IDENTITY_DOCUMENTS' THEN 'guest_hub.identity_documents' WHEN 'HOUSE_RULES' THEN 'guest_hub.house_rules' WHEN 'SERVICE_ORDERS' THEN 'guest_hub.service_orders' END AND rule.created_by IS NOT NULL AND rule.lifecycle='ACTIVE'
  AND rule.version=policy_version AND snapshot=jsonb_build_object('id',rule.id::text,'version',rule.version,'value',rule.value)
  AND rule.effective_from<=at_time AND (rule.effective_to IS NULL OR rule.effective_to>at_time)
  AND rule.value->>'source'=CASE form_key WHEN 'PROFILE' THEN 'NATIVE_RESERVATION_GUEST_PROFILE' WHEN 'STAY_DETAILS' THEN 'NATIVE_RESERVATION_GUEST_STAY_DETAILS' WHEN 'IDENTITY_DOCUMENTS' THEN 'NATIVE_GUEST_IDENTITY_DOCUMENTS' WHEN 'HOUSE_RULES' THEN 'NATIVE_PROPERTY_HOUSE_RULES_ACCEPTANCE' WHEN 'SERVICE_ORDERS' THEN 'NATIVE_CANONICAL_SERVICE_ORDERS' END AND rule.value->>'history'=CASE form_key WHEN 'PROFILE' THEN 'APPEND_ONLY_RESERVATION_PROFILE' WHEN 'STAY_DETAILS' THEN 'APPEND_ONLY_RESERVATION_STAY_DETAILS' WHEN 'IDENTITY_DOCUMENTS' THEN 'APPEND_ONLY_RESERVATION_IDENTITY_CAPTURES' WHEN 'HOUSE_RULES' THEN 'APPEND_ONLY_RESERVATION_HOUSE_RULES_ACCEPTANCE' WHEN 'SERVICE_ORDERS' THEN 'APPEND_ONLY_GUEST_NATIVE_ORDER_RECEIPTS' END
  AND rule.value->>'enabled'='true' AND length(btrim(rule.value->>'processing_approval_reference')) BETWEEN 1 AND 1000
  AND jsonb_typeof(rule.value->'notice')='object'
  AND (form_key IN('PROFILE','STAY_DETAILS') AND jsonb_typeof(rule.value->'allowed_fields')='array'
   OR form_key='IDENTITY_DOCUMENTS' AND jsonb_typeof(rule.value->'document_types')='array' AND jsonb_array_length(rule.value->'document_types')>0
    AND rule.value->>'storage'='EXISTING_ENCRYPTED_DOCUMENT_ARCHIVE' AND length(btrim(rule.value->>'retention_approval_reference')) BETWEEN 1 AND 1000
   OR form_key='HOUSE_RULES' AND app_guest_house_rules_actual_content(org,prop,rule.value)
   OR form_key='SERVICE_ORDERS' AND jsonb_typeof(rule.value->'allowed_service_keys')='array' AND jsonb_array_length(rule.value->'allowed_service_keys')>0
    AND length(btrim(rule.value->>'wording_approval_reference')) BETWEEN 1 AND 1000)
  AND (rule.scope_type='organization' AND rule.scope_id IS NULL OR rule.scope_type='property' AND rule.scope_id=p.id OR rule.scope_type='city' AND rule.scope_id=p.city_id
   OR rule.scope_type='agreement' AND EXISTS(SELECT 1 FROM management_agreement a WHERE a.organization_id=org AND a.id=rule.scope_id AND a.property_id=p.id AND a.archived_at IS NULL AND a.status<>'DRAFT' AND a.effective_from<=at_time AND (a.effective_to IS NULL OR a.effective_to>at_time))
   OR rule.scope_type='booking_source_property' AND EXISTS(SELECT 1 FROM booking_channel c WHERE c.organization_id=org AND c.id=rule.scope_id AND c.property_id=p.id AND c.source_key=r.source AND c.archived_at IS NULL)),false);
END $$;

CREATE OR REPLACE FUNCTION app_guard_guest_form_grant_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.id=NEW.outbox_event_id AND e.type='guest_hub.form_grant_recorded'
  AND e.payload=jsonb_build_object('grantId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'formKey',NEW.form_key,'decision',NEW.decision)
  AND e.idempotency_key='guest-hub-form-grant:'||NEW.created_by::text||':'||NEW.command_key::text AND e.occurred_at=NEW.created_at AND e.status='PENDING' AND e.attempt_count=0 AND e.xmin::text=pg_current_xact_id()::xid::text)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='guest_hub.form_grant_recorded' AND a.resource_type=CASE NEW.form_key WHEN 'PROFILE' THEN 'guest_hub_profile' WHEN 'STAY_DETAILS' THEN 'guest_hub_stay_details' WHEN 'IDENTITY_DOCUMENTS' THEN 'guest_hub_identity_documents' WHEN 'HOUSE_RULES' THEN 'guest_hub_house_rules' WHEN 'SERVICE_ORDERS' THEN 'guest_hub_service_orders' END
   AND a.resource_id=NEW.id AND a.property_scope_id=NEW.property_id AND a.request_id=NEW.request_id AND a.reason=NEW.reason AND a.occurred_at=NEW.created_at
   AND a.after=jsonb_build_object('grantId',NEW.id::text,'linkId',NEW.link_id::text,'reservationId',NEW.reservation_id::text,'formKey',NEW.form_key,'decision',NEW.decision,'commandHash',NEW.command_hash,'outboxEventId',NEW.outbox_event_id::text)
   AND a.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_form_grant_requires_exact_atomic_metadata_event_and_audit';END IF;
 IF NEW.form_key='IDENTITY_DOCUMENTS' AND NEW.decision='GRANTED' AND NOT EXISTS(
  SELECT 1 FROM guest_hub_identity_document_delegation d WHERE d.organization_id=NEW.organization_id AND d.grant_id=NEW.id AND d.created_at=NEW.created_at AND d.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_identity_grant_requires_atomic_original_document_authority_delegation';END IF;
 IF NEW.form_key='SERVICE_ORDERS' AND NEW.decision='GRANTED' AND NOT EXISTS(
  SELECT 1 FROM guest_hub_service_order_delegation d WHERE d.organization_id=NEW.organization_id AND d.grant_id=NEW.id
   AND d.created_at=NEW.created_at AND d.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'guest_service_grant_requires_atomic_original_order_delegation';END IF;
 RETURN NULL;
END $$;

ALTER TABLE guest_hub_service_order_delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_service_order_delegation FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_service_order_delegation_tenant_isolation ON guest_hub_service_order_delegation
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
CREATE TRIGGER guest_service_delegation_immutable BEFORE UPDATE OR DELETE ON guest_hub_service_order_delegation
  FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

ALTER TABLE guest_hub_service_order_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_hub_service_order_request FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_hub_service_order_request_tenant_isolation ON guest_hub_service_order_request
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
CREATE TRIGGER guest_service_request_immutable BEFORE UPDATE OR DELETE ON guest_hub_service_order_request
  FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

ALTER TABLE guest_hub_service_order_delegation ADD CONSTRAINT guest_service_delegation_shape CHECK (coalesce(
  catalog_rule_version > 0 AND ordering_rule_version > 0
  AND catalog_fingerprint ~ '^[a-f0-9]{64}$' AND authorization_cap_fingerprint ~ '^[a-f0-9]{64}$'
  AND source_fingerprint ~ '^[a-f0-9]{64}$' AND signature ~ '^[a-f0-9]{64}$'
  AND length(signature_version) BETWEEN 1 AND 120
  AND jsonb_typeof(ordering_snapshot) = 'object' AND jsonb_typeof(public_offers) = 'array'
  AND isfinite(created_at) AND isfinite(expires_at) AND expires_at > created_at, false));

ALTER TABLE guest_hub_service_order_request ADD CONSTRAINT guest_service_request_shape CHECK (coalesce(
  command_hash ~ '^[a-f0-9]{64}$' AND native_review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
  AND signature ~ '^[a-f0-9]{64}$' AND length(signature_version) BETWEEN 1 AND 120
  AND length(command_key_version) BETWEEN 1 AND 120 AND length(review_fingerprint) BETWEEN 40 AND 512
  AND length(request_id) BETWEEN 1 AND 200 AND requested_locale IN ('en','fr','ar')
  AND jsonb_typeof(selection_snapshot) = 'object' AND jsonb_typeof(notice_snapshot) = 'object'
  AND (total_amount IS NULL OR total_amount >= 0)
  AND isfinite(reviewed_at) AND isfinite(review_expires_at) AND isfinite(created_at)
  AND reviewed_at <= created_at AND created_at < review_expires_at, false));

CREATE FUNCTION app_guard_guest_service_delegation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM guest_hub_form_grant grant_row
    JOIN config_rule catalog ON catalog.organization_id = grant_row.organization_id AND catalog.id = NEW.catalog_rule_id
    JOIN config_rule ordering ON ordering.organization_id = grant_row.organization_id AND ordering.id = NEW.ordering_rule_id
    WHERE grant_row.organization_id = NEW.organization_id AND grant_row.id = NEW.grant_id
      AND grant_row.form_key = 'SERVICE_ORDERS' AND grant_row.decision = 'GRANTED'
      AND grant_row.created_at = NEW.created_at AND NEW.expires_at <= grant_row.expires_at
      AND grant_row.xmin::text = pg_current_xact_id()::xid::text
      AND catalog.key = 'services.pricing' AND catalog.version = NEW.catalog_rule_version AND catalog.lifecycle = 'ACTIVE'
      AND ordering.key = 'services.ordering' AND ordering.version = NEW.ordering_rule_version AND ordering.lifecycle = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'guest_service_delegation_requires_its_atomic_grant_and_native_catalog'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_service_delegation_source BEFORE INSERT ON guest_hub_service_order_delegation
  FOR EACH ROW EXECUTE FUNCTION app_guard_guest_service_delegation();

CREATE FUNCTION app_guard_guest_service_order_request() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM guest_hub_service_order_delegation delegation
    JOIN guest_hub_form_grant grant_row ON grant_row.organization_id = delegation.organization_id AND grant_row.id = delegation.grant_id
    JOIN service_order native_order ON native_order.organization_id = delegation.organization_id AND native_order.id = NEW.order_id
    JOIN service_order_event native_event ON native_event.organization_id = native_order.organization_id
      AND native_event.order_id = native_order.id AND native_event.id = NEW.event_id
    JOIN outbox_event outbox ON outbox.organization_id = NEW.organization_id AND outbox.id = NEW.outbox_event_id
    WHERE delegation.organization_id = NEW.organization_id AND delegation.grant_id = NEW.grant_id
      AND grant_row.link_id = NEW.link_id AND NEW.created_at >= delegation.created_at AND NEW.created_at < delegation.expires_at
      AND NOT EXISTS (SELECT 1 FROM guest_hub_form_grant later WHERE later.organization_id = grant_row.organization_id
        AND later.link_id = grant_row.link_id AND later.form_key = 'SERVICE_ORDERS' AND later.version > grant_row.version)
      AND native_order.property_id = grant_row.property_id AND native_order.reservation_id = grant_row.reservation_id
      AND native_order.catalog_rule_id = delegation.catalog_rule_id AND native_order.catalog_rule_version = delegation.catalog_rule_version
      AND native_order.currency = NEW.currency AND native_order.total_amount IS NOT DISTINCT FROM NEW.total_amount
      AND native_order.created_by = grant_row.created_by AND native_event.created_by = grant_row.created_by
      AND native_event.version = 1 AND native_event.from_state IS NULL
      AND native_event.review_fingerprint = NEW.native_review_fingerprint
      AND native_order.xmin::text = pg_current_xact_id()::xid::text AND native_event.xmin::text = pg_current_xact_id()::xid::text
      AND outbox.type = 'guest_hub.service_order_requested' AND outbox.status = 'PENDING' AND outbox.attempt_count = 0
      AND outbox.payload @> jsonb_build_object('requestId', NEW.id::text, 'linkId', NEW.link_id::text, 'orderId', NEW.order_id::text)
      AND outbox.xmin::text = pg_current_xact_id()::xid::text
  ) OR NOT EXISTS (
    SELECT 1 FROM audit_log audit JOIN guest_hub_form_grant grant_row
      ON grant_row.organization_id = audit.organization_id AND grant_row.id = NEW.grant_id
    WHERE audit.organization_id = NEW.organization_id AND audit.resource_type = 'guest_hub_service_orders'
      AND audit.action = 'guest_hub.service_order_requested' AND audit.resource_id = NEW.id AND audit.actor_id IS NULL
      AND audit.property_scope_id = grant_row.property_id AND audit.request_id = NEW.request_id
      AND audit.after @> jsonb_build_object('requestId', NEW.id::text, 'linkId', NEW.link_id::text, 'orderId', NEW.order_id::text)
      AND audit.xmin::text = pg_current_xact_id()::xid::text
  ) THEN RAISE EXCEPTION 'guest_service_request_requires_its_atomic_native_order_event_and_audit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guest_service_request_sources AFTER INSERT ON guest_hub_service_order_request
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_guest_service_order_request();

COMMIT;
