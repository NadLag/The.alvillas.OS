-- Widen the existing notification check atomically; no existing row is changed.
DO $$
DECLARE previous_check text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous_check FROM pg_constraint
  WHERE conrelid='notification'::regclass AND conname='notification_kind_check';
 IF previous_check IS NULL THEN RAISE EXCEPTION 'notification kind constraint is required'; END IF;
 EXECUTE format('ALTER TABLE notification ADD CONSTRAINT notification_kind_with_expense_notice CHECK ((%s) OR kind=%L)',previous_check,'expense_emergency');
 ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
 ALTER TABLE notification RENAME CONSTRAINT notification_kind_with_expense_notice TO notification_kind_check;
END $$;

CREATE FUNCTION app_expense_notice_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='expense_emergency' AND NOT EXISTS (
  SELECT 1 FROM expense_submission s JOIN outbox_event o ON o.organization_id=s.organization_id AND o.id=NEW.event_id
   CROSS JOIN LATERAL jsonb_array_elements(s.snapshot->'postHocNotices') n
  WHERE s.organization_id=NEW.organization_id AND s.expense_id=NEW.target_id AND (s.snapshot->>'postHocOwnerNotificationRequired')::boolean
   AND n->'recipients' ? NEW.recipient_id::text
   AND o.type='notification.requested' AND o.payload->>'kind'='expense_emergency'
   AND o.payload->>'targetId'=NEW.target_id::text AND o.payload->>'recipientId'=NEW.recipient_id::text
   AND o.idempotency_key='expense:'||s.expense_id||':emergency:'||(n->>'ownerId')||':'||NEW.recipient_id
 ) THEN RAISE EXCEPTION 'emergency expense notice requires its retained owner source'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_notice_source BEFORE INSERT ON notification FOR EACH ROW EXECUTE FUNCTION app_expense_notice_source_guard();

CREATE FUNCTION app_expense_emergency_integrity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expense_uuid uuid; s expense_submission%ROWTYPE; notice jsonb; policy jsonb;
BEGIN
 IF TG_TABLE_NAME='expense' THEN expense_uuid=NEW.id; ELSE expense_uuid=NEW.expense_id; END IF;
 SELECT * INTO s FROM expense_submission WHERE organization_id=NEW.organization_id AND expense_id=expense_uuid;
 IF s.id IS NULL OR NOT COALESCE((s.snapshot->>'postHocOwnerNotificationRequired')::boolean,false) THEN RETURN NEW; END IF;
 IF jsonb_typeof(s.snapshot->'postHocNotices') IS DISTINCT FROM 'array' OR jsonb_array_length(s.snapshot->'postHocNotices')=0
 THEN RAISE EXCEPTION 'emergency approval exception requires owner notices'; END IF;
 FOR policy IN SELECT value FROM jsonb_array_elements(s.snapshot->'policies') WHERE COALESCE((value#>>'{approval,postHocOwnerNotificationRequired}')::boolean,false) LOOP
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'postHocNotices') n WHERE n->>'ownerId'=policy->>'ownerId')
  THEN RAISE EXCEPTION 'every bypassed owner requires a notice'; END IF;
 END LOOP;
 FOR notice IN SELECT value FROM jsonb_array_elements(s.snapshot->'postHocNotices') LOOP
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'policies') p WHERE p->>'ownerId'=notice->>'ownerId'
    AND COALESCE((p#>>'{approval,postHocOwnerNotificationRequired}')::boolean,false)
    AND notice->'routing'=p#>'{approvalRule,snapshotValue,value,routing,owner}')
   OR NOT ((notice#>'{routing,channels}') ? 'in_app')
  THEN RAISE EXCEPTION 'owner exception notice must retain its configured routing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM notification n JOIN outbox_event o ON o.organization_id=n.organization_id AND o.id=n.event_id
    WHERE n.organization_id=s.organization_id AND n.target_id=s.expense_id AND n.kind='expense_emergency'
      AND notice->'recipients' ? n.recipient_id::text AND o.idempotency_key='expense:'||s.expense_id||':emergency:'||(notice->>'ownerId')||':'||n.recipient_id)
  THEN RAISE EXCEPTION 'emergency owner notice must be delivered atomically'; END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id=s.organization_id AND a.resource_type='expense'
   AND a.resource_id=s.expense_id AND a.action='expense.emergency_owner_notified' AND a.actor_id=s.submitted_by)
 THEN RAISE EXCEPTION 'emergency approval exception requires its audit flag'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER expense_emergency_integrity AFTER INSERT OR UPDATE ON expense DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_emergency_integrity_guard();
CREATE CONSTRAINT TRIGGER expense_submission_emergency_integrity AFTER INSERT ON expense_submission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_emergency_integrity_guard();
