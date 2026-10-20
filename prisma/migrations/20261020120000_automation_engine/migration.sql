CREATE TABLE automation_run (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(), organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 config_rule_id uuid NOT NULL REFERENCES config_rule(id) ON DELETE RESTRICT, rule_key text NOT NULL,
 event_id uuid NOT NULL, event_key text NOT NULL, property_id uuid NOT NULL, actor_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SUCCEEDED','SKIPPED','RETRY','FAILED','PAUSED')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count >= 0), next_attempt_at timestamptz(6), error_code text,
 inputs jsonb NOT NULL, outputs jsonb NOT NULL DEFAULT '[]', created_at timestamptz(6) NOT NULL DEFAULT now(), completed_at timestamptz(6),
 UNIQUE(organization_id,id), UNIQUE(organization_id,rule_key,event_key,property_id)
);
CREATE INDEX automation_run_organization_id_status_next_attempt_at_idx ON automation_run(organization_id,status,next_attempt_at);
CREATE INDEX automation_run_organization_id_property_id_created_at_id_idx ON automation_run(organization_id,property_id,created_at,id);
CREATE TABLE automation_attempt (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(), organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 run_id uuid NOT NULL, number integer NOT NULL, status text NOT NULL, error_code text, outputs jsonb NOT NULL,
 request_id text NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,run_id) REFERENCES automation_run(organization_id,id) ON DELETE RESTRICT,
 UNIQUE(organization_id,run_id,number)
);
CREATE TABLE automation_suggestion (
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(), organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 property_id uuid NOT NULL, outcome_key text NOT NULL, item_key text NOT NULL, title jsonb NOT NULL, quantity numeric(18,2) NOT NULL CHECK(quantity > 0),
 status text NOT NULL DEFAULT 'OPEN', created_by uuid NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT now(),
 UNIQUE(organization_id,outcome_key)
);
CREATE INDEX automation_suggestion_org_property_status_created_idx ON automation_suggestion(organization_id,property_id,status,created_at);
ALTER TABLE automation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_run FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_run_tenant_isolation ON automation_run USING(organization_id = current_setting('app.current_organization_id',true)::uuid) WITH CHECK(organization_id = current_setting('app.current_organization_id',true)::uuid);
ALTER TABLE automation_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_attempt_tenant_isolation ON automation_attempt USING(organization_id = current_setting('app.current_organization_id',true)::uuid) WITH CHECK(organization_id = current_setting('app.current_organization_id',true)::uuid);
ALTER TABLE automation_suggestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_suggestion FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_suggestion_tenant_isolation ON automation_suggestion USING(organization_id = current_setting('app.current_organization_id',true)::uuid) WITH CHECK(organization_id = current_setting('app.current_organization_id',true)::uuid);
CREATE TRIGGER automation_attempt_no_update BEFORE UPDATE OR DELETE ON automation_attempt FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE TRIGGER automation_run_no_delete BEFORE DELETE ON automation_run FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
CREATE TRIGGER automation_suggestion_no_delete BEFORE DELETE ON automation_suggestion FOR EACH ROW EXECUTE FUNCTION app_prevent_config_rule_mutation();
-- These references use composite tenant keys where available; the remaining references
-- are checked together so an elevated maintenance connection cannot cross tenants.
CREATE FUNCTION app_check_automation_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM property WHERE id=NEW.property_id AND organization_id=NEW.organization_id)
 OR NOT EXISTS(SELECT 1 FROM user_account WHERE id=NEW.actor_id AND organization_id=NEW.organization_id)
 OR NOT EXISTS(SELECT 1 FROM config_rule WHERE id=NEW.config_rule_id AND organization_id=NEW.organization_id)
 OR NOT EXISTS(SELECT 1 FROM outbox_event WHERE id=NEW.event_id AND organization_id=NEW.organization_id)
 THEN RAISE EXCEPTION 'automation tenant reference mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_run_tenant_references BEFORE INSERT OR UPDATE ON automation_run FOR EACH ROW EXECUTE FUNCTION app_check_automation_tenant();
CREATE FUNCTION app_automation_outbox_causation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chain text := current_setting('app.automation_path',true);
BEGIN
 IF chain IS NOT NULL AND chain <> '' AND NEW.type NOT LIKE 'notification.%' AND NEW.type NOT LIKE 'identity.%' THEN NEW.payload := NEW.payload || jsonb_build_object('automationPath',chain::jsonb); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outbox_automation_causation BEFORE INSERT ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_automation_outbox_causation();
CREATE FUNCTION app_check_automation_suggestion_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM property WHERE id=NEW.property_id AND organization_id=NEW.organization_id)
 OR NOT EXISTS(SELECT 1 FROM user_account WHERE id=NEW.created_by AND organization_id=NEW.organization_id)
 THEN RAISE EXCEPTION 'automation suggestion tenant reference mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_suggestion_tenant_references BEFORE INSERT OR UPDATE ON automation_suggestion FOR EACH ROW EXECUTE FUNCTION app_check_automation_suggestion_tenant();
CREATE FUNCTION app_automation_run_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.organization_id,NEW.config_rule_id,NEW.rule_key,NEW.event_id,NEW.event_key,NEW.property_id,NEW.actor_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.organization_id,OLD.config_rule_id,OLD.rule_key,OLD.event_id,OLD.event_key,OLD.property_id,OLD.actor_id,OLD.created_at)
 OR NEW.attempt_count < OLD.attempt_count
 OR (OLD.status IN ('SUCCEEDED','SKIPPED') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'automation execution history is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_run_projection_guard BEFORE UPDATE ON automation_run FOR EACH ROW EXECUTE FUNCTION app_automation_run_projection_guard();
