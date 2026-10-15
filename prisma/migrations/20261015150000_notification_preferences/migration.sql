CREATE TABLE notification_preference (
  id UUID PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  user_account_id UUID NOT NULL,
  in_app_enabled BOOLEAN NOT NULL DEFAULT true,
  in_app_account BOOLEAN NOT NULL DEFAULT true,
  in_app_operations BOOLEAN NOT NULL DEFAULT true,
  in_app_security BOOLEAN NOT NULL DEFAULT true CHECK (in_app_security),
  email_security BOOLEAN NOT NULL DEFAULT true CHECK (email_security),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_preference_account_tenant_fk FOREIGN KEY (organization_id, user_account_id)
    REFERENCES user_account(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX notification_preference_org_account_unique ON notification_preference (organization_id, user_account_id);
ALTER TABLE notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preference FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_preference_tenant_isolation ON notification_preference
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE FUNCTION app_protect_notification_preference_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'notification preferences cannot be deleted'; END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.user_account_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.user_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'notification preference identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_preference_identity BEFORE UPDATE OR DELETE ON notification_preference
  FOR EACH ROW EXECUTE FUNCTION app_protect_notification_preference_identity();

ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('language_updated', 'task_assigned', 'security_session_revoked'));
