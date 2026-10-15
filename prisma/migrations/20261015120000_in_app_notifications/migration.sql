CREATE UNIQUE INDEX user_account_org_id_unique ON user_account (organization_id, id);
CREATE TABLE notification (
  id UUID PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  recipient_id UUID NOT NULL,
  event_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('language_updated', 'task_assigned')),
  target_id UUID NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_recipient_tenant_fk FOREIGN KEY (organization_id, recipient_id)
    REFERENCES user_account(organization_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX notification_org_recipient_event_unique ON notification (organization_id, recipient_id, event_id);
CREATE INDEX notification_inbox_idx ON notification (organization_id, recipient_id, created_at DESC, id DESC);
CREATE INDEX notification_unread_idx ON notification (organization_id, recipient_id, read_at);
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_tenant_isolation ON notification
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE FUNCTION app_protect_notification_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'notification history is append-only'; END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.recipient_id, NEW.event_id, NEW.kind, NEW.target_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.recipient_id, OLD.event_id, OLD.kind, OLD.target_id, OLD.created_at)
      OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
    RAISE EXCEPTION 'only the first notification read timestamp may be written';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_history BEFORE UPDATE OR DELETE ON notification
  FOR EACH ROW EXECUTE FUNCTION app_protect_notification_history();
