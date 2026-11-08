-- Preserve terminal reminder history after recipient suspension. Open admission remains fail-closed.
CREATE OR REPLACE FUNCTION app_guard_lead_work_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original lead%ROWTYPE; predecessor lead_work_entry%ROWTYPE; subject_root lead_work_entry%ROWTYPE;
  subject_predecessor lead_work_entry%ROWTYPE; assignment_predecessor lead_work_entry%ROWTYPE;
  rule config_rule%ROWTYPE; capture config_rule%ROWTYPE; current_profile uuid; current_stage uuid;
BEGIN
  SELECT * INTO original FROM lead WHERE organization_id=NEW.organization_id AND id=NEW.lead_id;
  IF original.id IS NULL OR NEW.source_payload_sha256 IS DISTINCT FROM original.payload_sha256
    OR NOT isfinite(NEW.created_at) OR NEW.created_at<original.created_at OR NEW.created_at>clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM user_account u JOIN person p ON p.organization_id=u.organization_id AND p.id=u.person_id
      WHERE u.organization_id=NEW.organization_id AND u.id=NEW.created_by AND u.status='ACTIVE' AND p.archived_at IS NULL)
  THEN RAISE EXCEPTION 'lead work requires its actual original tenant capture and active author'; END IF;

  SELECT * INTO predecessor FROM lead_work_entry WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND number<NEW.number ORDER BY number DESC LIMIT 1;
  IF NEW.previous_id IS NULL THEN
    IF NEW.number<>1 OR predecessor.id IS NOT NULL THEN RAISE EXCEPTION 'lead work requires its exact initial global position'; END IF;
  ELSIF predecessor.id IS DISTINCT FROM NEW.previous_id OR NEW.number<>predecessor.number+1 OR NEW.created_at<predecessor.created_at
  THEN RAISE EXCEPTION 'lead work requires its exact immutable global predecessor'; END IF;

  SELECT * INTO subject_root FROM lead_work_entry WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND id=NEW.subject_id;
  IF subject_root.id IS NULL OR subject_root.kind<>NEW.kind OR subject_root.subject_id<>subject_root.id
    OR subject_root.previous_subject_id IS NOT NULL OR subject_root.subject_number<>1 OR subject_root.number>NEW.number
  THEN RAISE EXCEPTION 'lead work requires its actual immutable subject root'; END IF;
  IF NEW.previous_subject_id IS NULL THEN
    IF NEW.subject_id<>NEW.id OR NEW.subject_number<>1 OR (NEW.kind='REMINDER' AND NEW.reminder_state<>'OPEN')
    THEN RAISE EXCEPTION 'lead work requires its exact initial subject position'; END IF;
  ELSE
    SELECT * INTO subject_predecessor FROM lead_work_entry
      WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND subject_id=NEW.subject_id AND subject_number<NEW.subject_number
      ORDER BY subject_number DESC LIMIT 1;
    IF subject_predecessor.id IS DISTINCT FROM NEW.previous_subject_id OR subject_predecessor.kind<>NEW.kind
      OR NEW.subject_number<>subject_predecessor.subject_number+1 OR subject_predecessor.number>=NEW.number
      OR NEW.created_at<subject_predecessor.created_at
    THEN RAISE EXCEPTION 'lead work requires its exact immutable subject predecessor'; END IF;
  END IF;

  SELECT * INTO assignment_predecessor FROM lead_work_entry
    WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND kind='ASSIGNMENT' AND number<NEW.number ORDER BY number DESC LIMIT 1;
  IF NEW.source_assignment_id IS DISTINCT FROM assignment_predecessor.id
    OR (NEW.kind='ASSIGNMENT' AND assignment_predecessor.id IS NOT NULL
      AND (NEW.subject_id<>assignment_predecessor.subject_id OR NEW.previous_subject_id IS DISTINCT FROM assignment_predecessor.id))
  THEN RAISE EXCEPTION 'lead work requires its actual prior representative position'; END IF;
  SELECT id INTO current_profile FROM lead_profile_revision WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id ORDER BY number DESC LIMIT 1;
  SELECT id INTO current_stage FROM lead_stage_revision WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id ORDER BY number DESC LIMIT 1;
  IF NEW.source_profile_id IS DISTINCT FROM current_profile OR NEW.source_stage_id IS DISTINCT FROM current_stage
  THEN RAISE EXCEPTION 'lead work requires its actual current native profile and stage'; END IF;

  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
  IF rule.id IS NULL OR rule.key<>'crm.lead_work' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
    OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED')
    OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
    OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
    OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_PRIVATE_LEAD_WORK'
    OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_ACTIVITIES_REMINDERS_ASSIGNMENTS'
  THEN RAISE EXCEPTION 'lead work requires its actual organization work policy'; END IF;
  IF NOT coalesce(jsonb_typeof(rule.value->'activity_types')='array' AND jsonb_array_length(rule.value->'activity_types')>0
    AND jsonb_typeof(rule.value->'activity_future_seconds')='number' AND rule.value->>'activity_future_seconds' ~ '^(0|[1-9][0-9]{0,9})$'
    AND (rule.value->>'activity_future_seconds')::numeric<=2147483647
    AND rule.value#>>'{reminders,past_due}' IN('REJECT','ALLOW_DUE')
    AND jsonb_typeof(rule.value#>'{reminders,maximum_future_seconds}')='number'
    AND rule.value#>>'{reminders,maximum_future_seconds}' ~ '^(0|[1-9][0-9]{0,9})$'
    AND (rule.value#>>'{reminders,maximum_future_seconds}')::numeric<=2147483647
    AND jsonb_typeof(rule.value#>'{reminders,transitions}')='array',false)
  THEN RAISE EXCEPTION 'lead work requires complete explicit activity and reminder rules'; END IF;
  SELECT * INTO capture FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.capture_policy_id;
  IF capture.id IS NULL OR capture.key<>'crm.lead_capture' OR capture.scope_type<>'organization' OR capture.scope_id IS NOT NULL
    OR capture.archived_at IS NOT NULL OR capture.lifecycle NOT IN('ACTIVE','RETIRED')
    OR NEW.created_at<capture.effective_from OR (capture.effective_to IS NOT NULL AND NEW.created_at>=capture.effective_to)
    OR NEW.capture_policy_version<>capture.version OR NEW.capture_policy_snapshot IS DISTINCT FROM jsonb_build_object('id',capture.id,'version',capture.version,'value',capture.value)
    OR capture.value->>'source' IS DISTINCT FROM 'NATIVE_PRIVATE_LEAD_CAPTURE'
    OR length(coalesce(capture.value->>'processing_approval_reference',''))=0
    OR NOT coalesce(capture.value->'channels' ? original.channel,false)
  THEN RAISE EXCEPTION 'lead work requires its actual original processing policy'; END IF;

  IF NEW.kind='ACTIVITY' THEN
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rule.value->'activity_types') AS activity(value) WHERE activity.value->>'key'=NEW.activity_type_key)
      OR NEW.occurred_at>NEW.created_at+make_interval(secs=>(rule.value->>'activity_future_seconds')::integer)
    THEN RAISE EXCEPTION 'lead activity requires its actual configured type and occurrence'; END IF;
  ELSIF NEW.kind='REMINDER' THEN
    IF NEW.reminder_state='OPEN' AND NOT EXISTS(SELECT 1 FROM user_account u JOIN person p ON p.organization_id=u.organization_id AND p.id=u.person_id
      WHERE u.organization_id=NEW.organization_id AND u.id=NEW.recipient_id AND u.status='ACTIVE' AND p.archived_at IS NULL)
    THEN RAISE EXCEPTION 'lead reminder requires its actual active recipient'; END IF;
    IF NEW.previous_subject_id IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rule.value#>'{reminders,transitions}') AS transition(value)
        WHERE transition.value->>'from'=subject_predecessor.reminder_state AND transition.value->>'to'=NEW.reminder_state)
        OR (NEW.reminder_state<>'OPEN' AND (NEW.due_at IS DISTINCT FROM subject_predecessor.due_at OR NEW.recipient_id IS DISTINCT FROM subject_predecessor.recipient_id))
      THEN RAISE EXCEPTION 'lead reminder requires its configured native transition and original due source'; END IF;
    END IF;
    IF NEW.reminder_state='OPEN' AND (
      NEW.due_at>NEW.created_at+make_interval(secs=>(rule.value#>>'{reminders,maximum_future_seconds}')::integer)
      OR (rule.value#>>'{reminders,past_due}'='REJECT' AND NEW.due_at<NEW.created_at))
    THEN RAISE EXCEPTION 'lead reminder requires its actual configured due window'; END IF;
  ELSIF NEW.representative_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM user_account u JOIN person p ON p.organization_id=u.organization_id AND p.id=u.person_id
    WHERE u.organization_id=NEW.organization_id AND u.id=NEW.representative_id AND u.person_id=NEW.representative_person_id AND u.status='ACTIVE' AND p.archived_at IS NULL)
  THEN RAISE EXCEPTION 'lead assignment requires its actual active account and person'; END IF;

  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.actor_id=NEW.created_by
    AND l.action='crm.lead_work_recorded' AND l.resource_type='lead' AND l.resource_id=NEW.lead_id
    AND l.request_id=NEW.request_id AND l.occurred_at=NEW.created_at
    AND l.after=jsonb_build_object('leadId',NEW.lead_id,'entryId',NEW.id,'number',NEW.number,'subjectId',NEW.subject_id,'subjectNumber',NEW.subject_number,'kind',NEW.kind,
      'previousRevisionId',NEW.previous_id,'previousSubjectRevisionId',NEW.previous_subject_id,'commandHash',NEW.command_hash,'payloadSha256',NEW.payload_sha256,
      'policyId',NEW.policy_id,'capturePolicyId',NEW.capture_policy_id,'reviewFingerprint',NEW.review_fingerprint)
    AND l.xmin::text=pg_current_xact_id()::xid::text AND l.xmin::text=NEW.xmin::text)
  THEN RAISE EXCEPTION 'lead work requires its atomic private actor audit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id
    AND e.type='crm.lead_work_recorded' AND e.idempotency_key='crm.lead.work.recorded:'||NEW.id::text
    AND e.payload=jsonb_build_object('leadId',NEW.lead_id,'entryId',NEW.id,'subjectId',NEW.subject_id,'subjectNumber',NEW.subject_number,'kind',NEW.kind)
    AND e.occurred_at=NEW.created_at AND e.xmin::text=NEW.xmin::text)
  THEN RAISE EXCEPTION 'lead work requires its atomic identifier-only outbox event'; END IF;
  RETURN NULL;
END $$;
