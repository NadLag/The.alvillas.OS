-- A configured emergency owner bypass commits only with an actual retained inbox receipt.
-- Existing source, policy, approval and attributed-history guards remain in force.
CREATE FUNCTION app_employee_emergency_notice_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s employee_compensation_submission; c employee_compensation_cost; notice jsonb; expected_notices integer:=0; actual_receipts integer:=0;
BEGIN
 SELECT * INTO s FROM employee_compensation_submission WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'employee emergency source is unavailable';END IF;
 FOR c IN SELECT * FROM employee_compensation_cost WHERE organization_id=s.organization_id AND submission_id=s.id LOOP
  IF jsonb_typeof(c.policy_snapshot->'postHocNotices') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'employee cost requires its original owner notice policy';END IF;
  FOR notice IN SELECT value FROM jsonb_array_elements(c.policy_snapshot->'postHocNotices') LOOP
   expected_notices:=expected_notices+1;
   IF NOT s.emergency OR jsonb_typeof(notice->'recipients') IS DISTINCT FROM 'array'
    OR (notice->'routing'->'channels' @> '["in_app"]'::jsonb) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'employee owner bypass requires configured inbox delivery';END IF;
   SELECT count(*) INTO actual_receipts FROM notification n JOIN outbox_event e ON e.organization_id=n.organization_id AND e.id=n.event_id
    WHERE n.organization_id=s.organization_id AND n.kind='employee_cost_emergency' AND n.target_id=e.id AND e.type='notification.requested' AND e.status='DISPATCHED'
     AND e.payload->>'kind'='employee_cost_emergency' AND e.payload->>'targetId'=e.id::text AND e.payload->>'recipientId'=n.recipient_id::text
     AND e.payload->'employeeNotice'->>'submissionId'=s.id::text AND e.payload->'employeeNotice'->>'costId'=c.id::text
     AND e.payload->'employeeNotice'->>'ownerId'=notice->>'ownerId' AND notice->'recipients' @> to_jsonb(ARRAY[n.recipient_id::text])
     AND e.idempotency_key='employee-cost:'||c.id::text||':emergency:'||(notice->>'ownerId')||':'||n.recipient_id::text;
   IF actual_receipts=0 THEN RAISE EXCEPTION 'employee owner bypass requires its actual source inbox receipt';END IF;
  END LOOP;
 END LOOP;
 IF expected_notices>0 AND NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=s.organization_id AND a.resource_type='employee_compensation_submission'
  AND a.resource_id=s.id AND a.action='finance.employee_compensation.emergency_owner_notified' AND a.actor_id=s.submitted_by AND a.reason=s.reason
  AND a.after->>'submissionId'=s.id::text AND a.after->>'ownerApprovalBypassed'='true' AND (a.after->>'noticeCount')::integer>=expected_notices)
 THEN RAISE EXCEPTION 'employee owner bypass requires its attributed notice audit';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employee_emergency_notice_complete AFTER INSERT ON employee_compensation_submission
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_employee_emergency_notice_complete();
