-- CreateTable
CREATE TABLE "team_compensation" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "config_rule_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_compensation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_availability" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "decided_by" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_document" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "expires_on" DATE,
    "confirmed_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_wallet" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_wallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_compensation_org_assignment_effective_idx" ON "team_compensation"("organization_id", "assignment_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "team_compensation_org_assignment_version_unique" ON "team_compensation"("organization_id", "assignment_id", "version");

-- CreateIndex
CREATE INDEX "team_availability_org_person_dates_idx" ON "team_availability"("organization_id", "person_id", "starts_on", "ends_on");

-- CreateIndex
CREATE UNIQUE INDEX "team_document_storage_key_key" ON "team_document"("storage_key");

-- CreateIndex
CREATE INDEX "team_document_org_person_created_idx" ON "team_document"("organization_id", "person_id", "archived_at", "created_at");

-- CreateIndex
CREATE INDEX "team_document_org_expiry_idx" ON "team_document"("organization_id", "expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "team_wallet_person_id_key" ON "team_wallet"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_wallet_ledger_account_id_key" ON "team_wallet"("ledger_account_id");

-- CreateIndex
CREATE INDEX "team_wallet_org_person_idx" ON "team_wallet"("organization_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_wallet_org_person_unique" ON "team_wallet"("organization_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_wallet_org_account_unique" ON "team_wallet"("organization_id", "ledger_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_org_id_unique" ON "ledger_account"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "person_org_id_unique" ON "person"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignment_org_id_unique" ON "role_assignment"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "team_compensation" ADD CONSTRAINT "team_compensation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_compensation" ADD CONSTRAINT "team_compensation_organization_id_assignment_id_fkey" FOREIGN KEY ("organization_id", "assignment_id") REFERENCES "role_assignment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_availability" ADD CONSTRAINT "team_availability_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_availability" ADD CONSTRAINT "team_availability_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_document" ADD CONSTRAINT "team_document_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_document" ADD CONSTRAINT "team_document_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_wallet" ADD CONSTRAINT "team_wallet_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_wallet" ADD CONSTRAINT "team_wallet_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "person"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "team_wallet" ADD CONSTRAINT "team_wallet_organization_id_ledger_account_id_fkey" FOREIGN KEY ("organization_id", "ledger_account_id") REFERENCES "ledger_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- New business rows remain tenant isolated for application and database callers.
ALTER TABLE team_compensation ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_compensation FORCE ROW LEVEL SECURITY;
CREATE POLICY team_compensation_tenant_isolation ON team_compensation USING (organization_id = current_setting('app.current_organization_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
ALTER TABLE team_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_availability FORCE ROW LEVEL SECURITY;
CREATE POLICY team_availability_tenant_isolation ON team_availability USING (organization_id = current_setting('app.current_organization_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
ALTER TABLE team_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_document FORCE ROW LEVEL SECURITY;
CREATE POLICY team_document_tenant_isolation ON team_document USING (organization_id = current_setting('app.current_organization_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
ALTER TABLE team_wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_wallet FORCE ROW LEVEL SECURITY;
CREATE POLICY team_wallet_tenant_isolation ON team_wallet USING (organization_id = current_setting('app.current_organization_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
ALTER TABLE team_compensation ADD CONSTRAINT team_compensation_shape CHECK (version > 0 AND mode IN ('PER_JOB','PER_MONTH','PER_HOUR','PERCENTAGE') AND amount >= 0 AND (mode <> 'PERCENTAGE' OR amount <= 100) AND length(reason) >= 6);
ALTER TABLE team_compensation ADD CONSTRAINT team_compensation_config_fkey FOREIGN KEY(config_rule_id) REFERENCES config_rule(id) ON DELETE RESTRICT;
ALTER TABLE team_compensation ADD CONSTRAINT team_compensation_currency_fkey FOREIGN KEY(currency) REFERENCES currency(code) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE team_availability ADD CONSTRAINT team_availability_shape CHECK (starts_on < ends_on AND kind IN ('AVAILABLE','UNAVAILABLE','LEAVE') AND status IN ('REQUESTED','APPROVED','REJECTED','CANCELLED') AND length(reason) >= 6);
ALTER TABLE team_document ADD CONSTRAINT team_document_shape CHECK (kind IN ('CONTRACT','IDENTITY','OTHER') AND content_type IN ('application/pdf','image/jpeg','image/png') AND size > 0 AND storage_key LIKE organization_id::text || '/staff/' || person_id::text || '/%');

CREATE FUNCTION app_team_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'team history is immutable'; END $$;
CREATE TRIGGER team_compensation_immutable BEFORE UPDATE OR DELETE ON team_compensation FOR EACH ROW EXECUTE FUNCTION app_team_immutable();
CREATE TRIGGER team_wallet_immutable BEFORE UPDATE OR DELETE ON team_wallet FOR EACH ROW EXECUTE FUNCTION app_team_immutable();
CREATE TRIGGER team_availability_no_delete BEFORE DELETE ON team_availability FOR EACH ROW EXECUTE FUNCTION app_team_immutable();
CREATE TRIGGER team_document_no_delete BEFORE DELETE ON team_document FOR EACH ROW EXECUTE FUNCTION app_team_immutable();

CREATE FUNCTION app_team_compensation_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a role_assignment; previous team_compensation; c config_rule;
BEGIN
  SELECT * INTO a FROM role_assignment WHERE organization_id=NEW.organization_id AND id=NEW.assignment_id;
  PERFORM id FROM person WHERE organization_id=NEW.organization_id AND id=a.person_id FOR UPDATE;
  SELECT * INTO previous FROM team_compensation WHERE organization_id=NEW.organization_id AND assignment_id=NEW.assignment_id ORDER BY version DESC LIMIT 1;
  SELECT * INTO c FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.config_rule_id;
  IF a.id IS NULL OR a.archived_at IS NOT NULL OR NEW.version <> coalesce(previous.version,0)+1 OR (previous.id IS NOT NULL AND NEW.effective_from <= previous.effective_from)
    OR c.id IS NULL OR c.key <> 'staff.compensation' OR c.scope_type <> 'role_assignment' OR c.scope_id IS DISTINCT FROM a.id OR c.effective_from <> NEW.effective_from
    OR c.value->>'mode' IS DISTINCT FROM NEW.mode OR (c.value->>'amount')::numeric IS DISTINCT FROM NEW.amount OR c.value->>'currency' IS DISTINCT FROM NEW.currency
    OR NEW.effective_from < a.valid_from OR (a.valid_to IS NOT NULL AND NEW.effective_from >= a.valid_to) THEN
    RAISE EXCEPTION 'team compensation version, configuration or effective date conflict';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_compensation_check BEFORE INSERT ON team_compensation FOR EACH ROW EXECUTE FUNCTION app_team_compensation_check();
CREATE INDEX team_availability_org_person_status_dates_idx ON team_availability(organization_id,person_id,status,starts_on,ends_on);
CREATE INDEX operation_task_org_person_state_due_idx ON operation_task(organization_id,assigned_to_person_id,state,due_date);

CREATE FUNCTION app_team_availability_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM person WHERE organization_id=NEW.organization_id AND id=NEW.person_id FOR UPDATE;
  IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.organization_id,NEW.person_id,NEW.kind,NEW.starts_on,NEW.ends_on,NEW.reason,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.person_id,OLD.kind,OLD.starts_on,OLD.ends_on,OLD.reason,OLD.created_by,OLD.created_at)
    OR NOT ((OLD.status='REQUESTED' AND NEW.status IN ('APPROVED','REJECTED','CANCELLED')) OR (OLD.status='APPROVED' AND NEW.status='CANCELLED'))) THEN
    RAISE EXCEPTION 'team availability transition conflict';
  END IF;
  IF NEW.status='APPROVED' THEN
    IF EXISTS(SELECT 1 FROM team_availability WHERE organization_id=NEW.organization_id AND person_id=NEW.person_id AND id<>NEW.id AND status='APPROVED' AND starts_on<NEW.ends_on AND ends_on>NEW.starts_on)
      OR (NEW.kind<>'AVAILABLE' AND EXISTS(SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id AND t.archived_at IS NULL AND t.state NOT IN ('COMPLETED','CANCELLED') AND t.due_date>=NEW.starts_on AND t.due_date<NEW.ends_on
        AND (t.assigned_to_person_id=NEW.person_id OR t.assigned_to_user_account_id IN(SELECT id FROM user_account WHERE organization_id=NEW.organization_id AND person_id=NEW.person_id)))) THEN
      RAISE EXCEPTION 'team availability overlaps approved time or open tasks';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_availability_check BEFORE INSERT OR UPDATE ON team_availability FOR EACH ROW EXECUTE FUNCTION app_team_availability_check();

CREATE FUNCTION app_team_task_assignment_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; account_person uuid; inactive boolean;
BEGIN
  IF NEW.state IN ('COMPLETED','CANCELLED') OR NEW.archived_at IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.assigned_to_user_account_id IS NOT NULL THEN
    SELECT person_id, status<>'ACTIVE' INTO account_person,inactive FROM user_account WHERE organization_id=NEW.organization_id AND id=NEW.assigned_to_user_account_id;
    IF account_person IS NULL OR inactive THEN RAISE EXCEPTION 'team task assignee is inactive'; END IF;
  END IF;
  IF NEW.assigned_to_person_id IS NOT NULL AND account_person IS NOT NULL AND NEW.assigned_to_person_id<>account_person THEN RAISE EXCEPTION 'team task assignee mismatch'; END IF;
  target := coalesce(NEW.assigned_to_person_id,account_person);
  IF target IS NULL THEN RETURN NEW; END IF;
  PERFORM id FROM person WHERE organization_id=NEW.organization_id AND id=target AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'team task assignee is unavailable'; END IF;
  IF NEW.assigned_to_user_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND id=NEW.assigned_to_user_account_id AND status='ACTIVE') THEN
    RAISE EXCEPTION 'team task assignee is inactive';
  END IF;
  IF EXISTS(SELECT 1 FROM team_availability WHERE organization_id=NEW.organization_id AND person_id=target AND status='APPROVED' AND kind<>'AVAILABLE' AND starts_on<=NEW.due_date AND ends_on>NEW.due_date) THEN
    RAISE EXCEPTION 'team task conflicts with approved absence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_task_assignment_check BEFORE INSERT OR UPDATE OF assigned_to_person_id,assigned_to_user_account_id,due_date,state,archived_at ON operation_task FOR EACH ROW EXECUTE FUNCTION app_team_task_assignment_check();

CREATE FUNCTION app_team_offboarding_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='person' THEN
    IF NEW.archived_at IS NULL OR OLD.archived_at IS NOT NULL THEN RETURN NEW; END IF;
    target := NEW.id;
  ELSE
    IF NEW.status<>'DEACTIVATED' OR OLD.status='DEACTIVATED' THEN RETURN NEW; END IF;
    target := NEW.person_id;
  END IF;
  PERFORM id FROM person WHERE organization_id=NEW.organization_id AND id=target FOR UPDATE;
  IF EXISTS(SELECT 1 FROM operation_task WHERE organization_id=NEW.organization_id AND archived_at IS NULL AND state NOT IN ('COMPLETED','CANCELLED') AND (assigned_to_person_id=target OR assigned_to_user_account_id IN(SELECT id FROM user_account WHERE organization_id=NEW.organization_id AND person_id=target)))
    OR EXISTS(SELECT 1 FROM posting p JOIN team_wallet w ON w.organization_id=p.organization_id AND w.ledger_account_id=p.ledger_account_id WHERE w.organization_id=NEW.organization_id AND w.person_id=target GROUP BY p.currency HAVING sum(CASE WHEN p.side='DEBIT' THEN p.amount ELSE -p.amount END)<>0) THEN
    RAISE EXCEPTION 'team offboarding requires clear tasks and wallet';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_person_offboarding_check BEFORE UPDATE OF archived_at ON person FOR EACH ROW EXECUTE FUNCTION app_team_offboarding_check();
CREATE TRIGGER team_account_offboarding_check BEFORE UPDATE OF status ON user_account FOR EACH ROW EXECUTE FUNCTION app_team_offboarding_check();
CREATE FUNCTION app_team_wallet_posting_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  PERFORM id FROM ledger_account WHERE organization_id=NEW.organization_id AND id=NEW.ledger_account_id FOR UPDATE;
  SELECT person_id INTO target FROM team_wallet WHERE organization_id=NEW.organization_id AND ledger_account_id=NEW.ledger_account_id;
  IF target IS NOT NULL THEN
    PERFORM id FROM person WHERE organization_id=NEW.organization_id AND id=target AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'team wallet holder is offboarded'; END IF;
    IF EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND person_id=target AND status='DEACTIVATED') AND NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND person_id=target AND status='ACTIVE') THEN
      RAISE EXCEPTION 'team wallet holder is offboarded';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_wallet_posting_check BEFORE INSERT ON posting FOR EACH ROW EXECUTE FUNCTION app_team_wallet_posting_check();

CREATE FUNCTION app_team_wallet_link_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM person WHERE organization_id=NEW.organization_id AND id=NEW.person_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'team wallet holder is offboarded'; END IF;
  PERFORM id FROM ledger_account WHERE organization_id=NEW.organization_id AND id=NEW.ledger_account_id AND account_type='STAFF_WALLET' AND normal_side='DEBIT' AND archived_at IS NULL FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'team wallet requires a dedicated custody ledger account'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_wallet_link_check BEFORE INSERT ON team_wallet FOR EACH ROW EXECUTE FUNCTION app_team_wallet_link_check();
CREATE FUNCTION app_team_wallet_account_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.account_type,OLD.normal_side) IS DISTINCT FROM ROW(NEW.account_type,NEW.normal_side) AND EXISTS(SELECT 1 FROM team_wallet WHERE organization_id=OLD.organization_id AND ledger_account_id=OLD.id) THEN RAISE EXCEPTION 'team wallet ledger identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_wallet_account_check BEFORE UPDATE OF account_type,normal_side ON ledger_account FOR EACH ROW EXECUTE FUNCTION app_team_wallet_account_check();
CREATE FUNCTION app_team_document_update_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id,OLD.organization_id,OLD.person_id,OLD.title,OLD.kind,OLD.storage_key,OLD.content_type,OLD.size,OLD.expires_on,OLD.confirmed_at,OLD.created_by,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.person_id,NEW.title,NEW.kind,NEW.storage_key,NEW.content_type,NEW.size,NEW.expires_on,NEW.confirmed_at,NEW.created_by,NEW.created_at) OR OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'team document history is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_document_update_check BEFORE UPDATE ON team_document FOR EACH ROW EXECUTE FUNCTION app_team_document_update_check();

-- Business schedules and upload limits are editable, versioned configuration.
INSERT INTO config_rule(organization_id,key,scope_type,value,effective_from,version,reason)
SELECT id,'staff.management_policy','organization','{"document_max_bytes":10000000,"document_reminder_days":[30,7,0],"document_link_seconds":120}'::jsonb,'2026-01-01'::timestamptz,1,'Initial configurable staff document policy'
FROM organization WHERE NOT EXISTS(SELECT 1 FROM config_rule c WHERE c.organization_id=organization.id AND c.key='staff.management_policy');

ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK(kind IN ('language_updated','task_assigned','task_completed','reservation_created','security_session_revoked','approval_requested','approval_decided','staff_document_expiring'));
