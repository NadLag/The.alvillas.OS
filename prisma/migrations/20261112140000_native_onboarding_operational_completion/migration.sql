BEGIN;

ALTER TABLE property_onboarding_revision DROP CONSTRAINT property_onboarding_revision_shape;
ALTER TABLE property_onboarding_revision ADD CONSTRAINT property_onboarding_revision_shape CHECK(coalesce(number>0
 AND ((step='OWNER' AND property_id IS NULL AND mode IN('CREATE','LINK'))
  OR (step='PROPERTY' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>1 AND mode IN('CREATE','LINK'))
  OR (step='OPERATING_PROFILE' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>2 AND mode IN('LINK','UPDATE'))
  OR (step='MANAGEMENT_AGREEMENT' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>3 AND mode IN('CREATE','LINK'))
  OR (step='TEAM' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>4 AND mode IN('LINK','ASSIGN'))
  OR (step='BOOKING_CHANNELS' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>5 AND mode IN('LINK','CONFIGURE'))
  OR (step='INVENTORY' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>6 AND mode IN('TEMPLATE','CUSTOM'))
  OR (step='SERVICES' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>7 AND mode IN('LINK','TEMPLATE','CUSTOM'))
  OR (step='WORKFLOWS' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>8 AND mode='TEMPLATE')
  OR (step='REVIEW' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>9 AND mode='VALIDATE') OR (step='ACTIVATE' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>10 AND mode='BACKGROUND'))
 AND isfinite(created_at) AND payload_schema_version=1
 AND octet_length(encrypted_payload) BETWEEN 64 AND (CASE WHEN step='OWNER' THEN 66304 WHEN step IN('INVENTORY','SERVICES') THEN 4194304 WHEN step='WORKFLOWS' THEN 33554432 WHEN step='REVIEW' THEN 134217728 ELSE 196608 END)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND length(request_id) BETWEEN 1 AND 1000,false));

ALTER TABLE property_onboarding_activation_event DROP CONSTRAINT onboarding_activation_event_shape;
ALTER TABLE property_onboarding_activation_event ADD CONSTRAINT onboarding_activation_event_shape CHECK(coalesce(
 sequence>0 AND isfinite(occurred_at) AND actor_id IS NOT NULL AND length(request_id) BETWEEN 1 AND 1000
 AND (next_attempt_at IS NULL OR isfinite(next_attempt_at) AND next_attempt_at>occurred_at)
 AND CASE WHEN type='REQUESTED' THEN sequence=1 AND previous_id IS NULL AND effect_kind IS NULL AND attempt IS NULL AND result IS NULL AND result_fingerprint IS NULL AND failure_code IS NULL AND next_attempt_at IS NULL
 WHEN type='ACTIVATED' THEN sequence>1 AND previous_id IS NOT NULL AND effect_kind IS NULL AND attempt IS NULL AND jsonb_typeof(result)='object' AND result_fingerprint ~ '^[a-f0-9]{64}$' AND failure_code IS NULL AND next_attempt_at IS NULL
 WHEN effect_kind IS NULL AND type IN('STARTED','BLOCKED','RETRY_SCHEDULED','FAILED') THEN sequence>1 AND previous_id IS NOT NULL AND attempt>0 AND result IS NULL AND result_fingerprint IS NULL AND CASE WHEN type='STARTED' THEN failure_code IS NULL AND next_attempt_at IS NULL ELSE failure_code ~ '^[A-Z][A-Z0-9_]{0,95}$' AND (type='RETRY_SCHEDULED')=(next_attempt_at IS NOT NULL) END
 ELSE sequence>1 AND previous_id IS NOT NULL AND effect_kind IN('WORKFLOWS','DOCUMENTS','EMAIL','TASKS','NOTIFICATION') AND attempt>0
  AND CASE WHEN type='STARTED' THEN result IS NULL AND result_fingerprint IS NULL AND failure_code IS NULL AND next_attempt_at IS NULL
  WHEN type='SUCCEEDED' THEN jsonb_typeof(result)='object' AND result_fingerprint ~ '^[a-f0-9]{64}$' AND failure_code IS NULL AND next_attempt_at IS NULL
  WHEN type IN('RETRY_SCHEDULED','BLOCKED','FAILED') THEN result IS NULL AND result_fingerprint IS NULL AND failure_code ~ '^[A-Z][A-Z0-9_]{0,95}$' AND (type='RETRY_SCHEDULED')=(next_attempt_at IS NOT NULL)
  ELSE false END END,false));

CREATE OR REPLACE FUNCTION app_assert_onboarding_activation_effect(org uuid,activation uuid,kind text,evidence jsonb,checksum text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request property_onboarding_activation_request%ROWTYPE;review property_onboarding_revision%ROWTYPE;source config_rule%ROWTYPE;definition config_rule%ROWTYPE;package owner_onboarding_package%ROWTYPE;delivery owner_onboarding_delivery%ROWTYPE;message notification_delivery%ROWTYPE;pin jsonb;entry jsonb;configured jsonb;effect_key text;hash text;expected_key text;position integer:=0;total integer;
BEGIN
 SELECT * INTO request FROM property_onboarding_activation_request WHERE organization_id=org AND id=activation;
 IF request.id IS NULL OR NOT coalesce(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=1048576
  AND evidence->>'protocol'='NATIVE_ONBOARDING_ACTIVATION_EFFECT_V1' AND evidence->>'activationId'=activation::text AND evidence->>'effectKind'=kind,false)
 THEN RAISE EXCEPTION 'activation effect requires its actual canonical evidence';END IF;
 IF kind IN('WORKFLOWS','TASKS') THEN
  IF NOT coalesce(evidence ?& ARRAY['sourceRuleId','sourceFingerprint'] AND jsonb_typeof(evidence->'sourceFingerprint')='string' AND evidence->>'sourceFingerprint' ~ '^[a-f0-9]{64}$',false) THEN RAISE EXCEPTION 'activation effect requires its original workflow catalog';END IF;
  SELECT * INTO review FROM property_onboarding_revision WHERE organization_id=org AND id=request.review_revision_id;
  SELECT item->'row' INTO pin FROM jsonb_array_elements(review.source_snapshot#>'{workflows,rules}') AS rows(item) WHERE item->>'key'='ops.workflows';
  SELECT * INTO source FROM config_rule WHERE organization_id=org AND id=(evidence->>'sourceRuleId')::uuid;
  IF NOT coalesce(source.id::text=pin->>'id' AND source.key='ops.workflows' AND source.version::text=pin->>'version' AND source.lifecycle='ACTIVE' AND source.archived_at IS NULL
   AND EXISTS(SELECT 1 FROM config_rule WHERE organization_id=org AND id=source.id AND xmin::text=pin->>'xmin' AND ctid::text=pin->>'tuple'),false)
  THEN RAISE EXCEPTION 'activation effect requires its actual unchanged selected catalog';END IF;
 END IF;
 IF kind='WORKFLOWS' THEN
  IF evidence-ARRAY['protocol','activationId','effectKind','sourceRuleId','sourceFingerprint','workflows']<>'{}'::jsonb OR jsonb_typeof(evidence->'workflows') IS DISTINCT FROM 'array' OR jsonb_typeof(source.value->'workflows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'activation workflow references required';END IF;
  total=jsonb_array_length(evidence->'workflows');
  IF total>100 OR total<>jsonb_array_length(source.value->'workflows') OR total<(request.policy_snapshot#>>'{value,workflows,minimum_workflows}')::int OR (SELECT count(DISTINCT item->>'ruleId') FROM jsonb_array_elements(evidence->'workflows') AS rows(item))<>total THEN RAISE EXCEPTION 'activation requires every distinct canonical workflow';END IF;
  FOR entry IN SELECT item FROM jsonb_array_elements(evidence->'workflows') AS rows(item) LOOP
   configured=source.value->'workflows'->position;effect_key=app_onboarding_effect_slug(configured->>'key');
   hash=encode(digest(convert_to(replace(jsonb_build_array('native-onboarding-canonical-workflow-v1',org::text,request.property_id::text,effect_key)::text,', ',','),'UTF8'),'sha256'),'hex');expected_key='automation.rule.onb_'||substring(hash,1,48);
   SELECT * INTO definition FROM config_rule WHERE organization_id=org AND id=(entry->>'ruleId')::uuid;
   IF NOT coalesce(jsonb_typeof(entry)='object' AND entry ?& ARRAY['workflowKey','key','ruleId','version','fingerprint'] AND entry-ARRAY['workflowKey','key','ruleId','version','fingerprint']='{}'::jsonb
    AND jsonb_typeof(entry->'workflowKey')='string' AND jsonb_typeof(entry->'key')='string' AND jsonb_typeof(entry->'version')='number' AND jsonb_typeof(entry->'fingerprint')='string'
    AND entry->>'workflowKey'=effect_key AND entry->>'key'=expected_key AND entry->>'fingerprint' ~ '^[a-f0-9]{64}$' AND definition.key=expected_key AND definition.scope_type='property' AND definition.scope_id=request.property_id
    AND definition.version::text=entry->>'version' AND definition.lifecycle='ACTIVE' AND definition.archived_at IS NULL AND definition.created_by IS NOT NULL
    AND definition.effective_from=source.effective_from AND definition.effective_to IS NOT DISTINCT FROM source.effective_to
    AND NOT EXISTS(SELECT 1 FROM config_rule later WHERE later.organization_id=org AND later.key=definition.key AND later.scope_type=definition.scope_type AND later.scope_id=definition.scope_id AND later.version>definition.version)
    AND EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=org AND a.actor_id=definition.created_by AND a.action='config_rule.version.created' AND a.resource_id=definition.id AND a.after->>'id'=definition.id::text AND a.after->'value'=definition.value),false)
   THEN RAISE EXCEPTION 'activation requires its actual current canonical workflow versions';END IF;
   position=position+1;
  END LOOP;
 ELSIF kind='TASKS' THEN
  configured=source.value->'onboarding_tasks';
  IF evidence-ARRAY['protocol','activationId','effectKind','sourceRuleId','sourceFingerprint','tasks']<>'{}'::jsonb OR jsonb_typeof(evidence->'tasks') IS DISTINCT FROM 'array' OR jsonb_typeof(configured->'items') IS DISTINCT FROM 'array' OR jsonb_typeof(configured->'minimum') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'activation task references and explicit settings required';END IF;
  total=jsonb_array_length(evidence->'tasks');
  IF total>100 OR configured->>'minimum' !~ '^(0|[1-9][0-9]*)$' OR (configured->>'minimum')::int NOT BETWEEN 0 AND 100 OR total<>jsonb_array_length(configured->'items') OR total<(configured->>'minimum')::int OR (SELECT count(DISTINCT item->>'taskId') FROM jsonb_array_elements(evidence->'tasks') AS rows(item))<>total THEN RAISE EXCEPTION 'activation requires every distinct canonical task';END IF;
  FOR entry IN SELECT item FROM jsonb_array_elements(evidence->'tasks') AS rows(item) LOOP
   effect_key=app_onboarding_effect_slug(configured->'items'->position->>'key');hash=encode(digest(convert_to(replace(jsonb_build_array('native-onboarding-task-v1',org::text,request.property_id::text,activation::text,effect_key)::text,', ',','),'UTF8'),'sha256'),'hex');
   expected_key=substring(hash,1,8)||'-'||substring(hash,9,4)||'-5'||substring(hash,14,3)||'-a'||substring(hash,18,3)||'-'||substring(hash,21,12);
   IF NOT coalesce(jsonb_typeof(entry)='object' AND entry ?& ARRAY['key','taskId','commandKey'] AND entry-ARRAY['key','taskId','commandKey']='{}'::jsonb AND jsonb_typeof(entry->'key')='string' AND entry->>'key'=effect_key AND entry->>'commandKey'=expected_key
    AND EXISTS(SELECT 1 FROM operation_task_mutation m JOIN operation_task t ON t.organization_id=m.organization_id AND t.id=m.task_id WHERE m.organization_id=org AND m.key=expected_key::uuid AND m.task_id=(entry->>'taskId')::uuid AND m.created_by=request.created_by AND t.property_id=request.property_id
     AND EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=org AND a.actor_id=request.created_by AND a.action='task.create' AND a.resource_id=t.id AND a.reason='onboarding.activation.tasks:'||activation::text||':'||effect_key)
     AND EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=org AND e.type='TaskCreated' AND e.payload->>'taskId'=t.id::text AND e.payload->>'propertyId'=request.property_id::text)),false)
   THEN RAISE EXCEPTION 'activation requires its actual canonical task creation receipts';END IF;
   position=position+1;
  END LOOP;
 ELSIF kind IN('DOCUMENTS','EMAIL','NOTIFICATION') THEN
  SELECT * INTO package FROM owner_onboarding_package WHERE organization_id=org AND command_key=activation;
  IF NOT coalesce(package.id IS NOT NULL AND package.session_id=request.session_id AND package.review_revision_id=request.review_revision_id AND package.owner_id=request.owner_id AND package.property_id=request.property_id AND package.created_by=request.created_by AND package.authorization_cap=request.authorization_cap,false) THEN RAISE EXCEPTION 'activation requires its actual original owner package';END IF;
  IF (SELECT count(*) FROM owner_onboarding_package_item WHERE organization_id=org AND package_id=package.id)<>jsonb_array_length(package.document_plan)
   OR EXISTS(SELECT 1 FROM owner_onboarding_package_item item WHERE item.organization_id=org AND item.package_id=package.id AND NOT EXISTS(
    SELECT 1 FROM document_instance i JOIN document d ON d.organization_id=i.organization_id AND d.id=i.document_id
    JOIN document_admission a ON a.organization_id=i.organization_id AND a.created_by=i.created_by AND a.command_key=i.command_key AND a.command_hash=i.command_hash AND a.document_id=i.document_id AND a.input->>'generationInstanceId'=i.id::text
    JOIN document_version v ON v.organization_id=a.organization_id AND v.admission_id=a.id AND v.document_id=i.document_id
    WHERE i.organization_id=org AND i.id=item.instance_id AND i.created_by=request.created_by AND d.source_kind='ONBOARDING' AND d.source_id=request.review_revision_id AND d.locale=item.locale AND a.content_type='application/pdf' AND a.file_size>0 AND v.cipher_size>0 AND v.created_by=request.created_by))
  THEN RAISE EXCEPTION 'activation requires every actual archived owner PDF';END IF;
  IF kind='DOCUMENTS' THEN
   IF evidence-ARRAY['protocol','activationId','effectKind','packageId']<>'{}'::jsonb OR evidence->>'packageId' IS DISTINCT FROM package.id::text THEN RAISE EXCEPTION 'activation document package identity required';END IF;
  ELSE
   SELECT * INTO delivery FROM owner_onboarding_delivery WHERE organization_id=org AND id=(evidence->>'ownerDeliveryId')::uuid;
   SELECT * INTO message FROM notification_delivery WHERE organization_id=org AND id=(evidence->>'deliveryRecordId')::uuid;
   IF NOT coalesce(delivery.package_id=package.id AND delivery.owner_id=request.owner_id AND delivery.property_id=request.property_id AND delivery.created_by=request.created_by AND delivery.authorization_cap=request.authorization_cap
    AND EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=org AND e.id=delivery.command_key AND e.type='onboarding.activation_requested' AND e.idempotency_key='onboarding.activation:'||activation::text)
    AND message.event_id=delivery.outbox_event_id AND message.channel='email' AND message.kind='onboarding.owner_package' AND message.recipient_key=delivery.recipient_key AND length(message.provider_id)>0 AND message.accepted_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM notification_delivery_log l WHERE l.organization_id=org AND l.delivery_id=message.id AND l.outcome='ACCEPTED'),false)
   THEN RAISE EXCEPTION 'activation requires its actual canonical owner email acceptance';END IF;
   IF kind='EMAIL' THEN
    IF evidence-ARRAY['protocol','activationId','effectKind','ownerDeliveryId','deliveryRecordId','acceptedAt']<>'{}'::jsonb OR jsonb_typeof(evidence->'acceptedAt') IS DISTINCT FROM 'string' OR message.status NOT IN('ACCEPTED','DELIVERED') OR (evidence->>'acceptedAt')::timestamptz IS DISTINCT FROM message.accepted_at THEN RAISE EXCEPTION 'activation requires actual provider acknowledgement';END IF;
   ELSE
    IF evidence-ARRAY['protocol','activationId','effectKind','ownerDeliveryId','deliveryRecordId','deliveredAt']<>'{}'::jsonb OR jsonb_typeof(evidence->'deliveredAt') IS DISTINCT FROM 'string' OR message.status<>'DELIVERED' OR message.delivered_at IS NULL OR (evidence->>'deliveredAt')::timestamptz IS DISTINCT FROM message.delivered_at
     OR NOT EXISTS(SELECT 1 FROM notification_delivery_log l WHERE l.organization_id=org AND l.delivery_id=message.id AND l.outcome='email.delivered' AND l.key LIKE '%webhook:%' AND l.occurred_at=message.delivered_at)
    THEN RAISE EXCEPTION 'activation requires actual verified owner notification delivery';END IF;
   END IF;
  END IF;
 ELSE RAISE EXCEPTION 'unsupported native activation effect';
 END IF;
 IF checksum IS DISTINCT FROM encode(digest(convert_to(app_onboarding_effect_json_text(evidence),'UTF8'),'sha256'),'hex') THEN RAISE EXCEPTION 'activation effect requires its complete metadata fingerprint';END IF;
END $$;

CREATE OR REPLACE FUNCTION app_guard_onboarding_activation_event() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request property_onboarding_activation_request%ROWTYPE;head property_onboarding_activation_event%ROWTYPE;phase property_onboarding_activation_event%ROWTYPE;dependency TEXT;maximum INTEGER;activated property_onboarding_revision%ROWTYPE;request_xmin TEXT;activated_xmin TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:activation:'||NEW.activation_id::text,0));
 SELECT * INTO request FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND id=NEW.activation_id;
 SELECT xmin::text INTO request_xmin FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND id=NEW.activation_id;
 SELECT * INTO head FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id ORDER BY sequence DESC LIMIT 1;
 IF request.id IS NULL OR NEW.actor_id IS DISTINCT FROM request.created_by OR NEW.previous_id IS DISTINCT FROM head.id OR NEW.sequence<>coalesce(head.sequence,0)+1
  OR NEW.occurred_at<request.created_at OR (head.id IS NOT NULL AND NEW.occurred_at<head.occurred_at) OR head.type IN('ACTIVATED','FAILED')
 THEN RAISE EXCEPTION 'activation events require their actual consecutive immutable run head'; END IF;
 IF NEW.type='REQUESTED' THEN
  IF head.id IS NOT NULL OR NEW.occurred_at<>request.created_at OR NEW.request_id<>request.request_id OR request_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text THEN RAISE EXCEPTION 'activation requires its atomic initial request event'; END IF;
 ELSIF NEW.type='ACTIVATED' THEN
  FOREACH dependency IN ARRAY ARRAY['WORKFLOWS','DOCUMENTS','EMAIL','TASKS','NOTIFICATION'] LOOP
   SELECT * INTO phase FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id AND effect_kind=dependency ORDER BY sequence DESC LIMIT 1;
   IF phase.type IS DISTINCT FROM 'SUCCEEDED' THEN RAISE EXCEPTION 'activation requires every real effect receipt'; END IF;
  END LOOP;
  SELECT * INTO activated FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND id=(NEW.result->>'revisionId')::uuid;
  SELECT xmin::text INTO activated_xmin FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND id=(NEW.result->>'revisionId')::uuid;
  IF activated.id IS NULL OR activated.step<>'ACTIVATE' OR activated.mode<>'BACKGROUND' OR activated.session_id<>request.session_id OR activated.previous_id<>request.review_revision_id
   OR activated.owner_id<>request.owner_id OR activated.property_id<>request.property_id OR activated.created_by<>request.created_by
   OR activated.created_at<>NEW.occurred_at OR activated_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text
   OR NEW.result IS DISTINCT FROM jsonb_build_object('revisionId',activated.id,'activatedAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   OR NOT EXISTS(SELECT 1 FROM property WHERE organization_id=NEW.organization_id AND id=request.property_id AND archived_at IS NULL AND status='ACTIVE' AND xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'activation completion requires its atomic native revision and canonical operational property'; END IF;
 ELSIF NEW.effect_kind IS NULL THEN
  FOREACH dependency IN ARRAY ARRAY['WORKFLOWS','DOCUMENTS','EMAIL','TASKS','NOTIFICATION'] LOOP
   IF (SELECT type FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id AND effect_kind=dependency ORDER BY sequence DESC LIMIT 1) IS DISTINCT FROM 'SUCCEEDED' THEN RAISE EXCEPTION 'activation completion requires every actual effect';END IF;
  END LOOP;
  SELECT * INTO phase FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id AND effect_kind IS NULL AND type NOT IN('REQUESTED','ACTIVATED') ORDER BY sequence DESC LIMIT 1;
  maximum=(request.policy_snapshot#>>'{value,activation,retry,max_attempts}')::int;
  IF NEW.attempt>maximum THEN RAISE EXCEPTION 'activation completion attempt exceeds approved policy';END IF;
  IF NEW.type='STARTED' THEN
   IF phase.type IS NOT NULL AND phase.type NOT IN('RETRY_SCHEDULED','BLOCKED') OR NEW.attempt<>coalesce(phase.attempt,0)+1 OR phase.next_attempt_at>NEW.occurred_at THEN RAISE EXCEPTION 'activation completion requires an eligible attempt';END IF;
  ELSIF phase.type IS DISTINCT FROM 'STARTED' OR NEW.attempt IS DISTINCT FROM phase.attempt THEN RAISE EXCEPTION 'activation completion outcome requires its started attempt';
  ELSIF NEW.type='RETRY_SCHEDULED' AND (NEW.attempt>=maximum OR NEW.next_attempt_at<>NEW.occurred_at+make_interval(secs=>(request.policy_snapshot#>>'{value,activation,retry,backoff_seconds}')::int)) THEN RAISE EXCEPTION 'activation completion retry requires approved backoff';END IF;
 ELSE
  SELECT * INTO phase FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id AND effect_kind=NEW.effect_kind ORDER BY sequence DESC LIMIT 1;
  maximum=(request.policy_snapshot->'value'->'activation'->'retry'->>'max_attempts')::int;
  IF NEW.attempt>maximum THEN RAISE EXCEPTION 'activation attempt exceeds its approved retry policy'; END IF;
  IF NEW.type='STARTED' THEN
   IF phase.type IS NOT NULL AND phase.type NOT IN('RETRY_SCHEDULED','BLOCKED') OR NEW.attempt<>coalesce(phase.attempt,0)+1 OR phase.next_attempt_at>NEW.occurred_at THEN RAISE EXCEPTION 'activation effect requires an eligible next attempt'; END IF;
   FOREACH dependency IN ARRAY CASE NEW.effect_kind WHEN 'WORKFLOWS' THEN ARRAY[]::text[] WHEN 'DOCUMENTS' THEN ARRAY['WORKFLOWS'] WHEN 'EMAIL' THEN ARRAY['DOCUMENTS'] WHEN 'TASKS' THEN ARRAY['WORKFLOWS'] ELSE ARRAY['EMAIL','TASKS'] END LOOP
    IF (SELECT type FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id AND effect_kind=dependency ORDER BY sequence DESC LIMIT 1) IS DISTINCT FROM 'SUCCEEDED' THEN RAISE EXCEPTION 'activation effect requires successful dependencies'; END IF;
   END LOOP;
  ELSIF phase.type IS DISTINCT FROM 'STARTED' OR NEW.attempt IS DISTINCT FROM phase.attempt THEN RAISE EXCEPTION 'activation outcome requires its actual started attempt';
  ELSIF NEW.type='RETRY_SCHEDULED' AND (NEW.attempt>=maximum OR NEW.next_attempt_at<>NEW.occurred_at+make_interval(secs=>(request.policy_snapshot->'value'->'activation'->'retry'->>'backoff_seconds')::int)) THEN RAISE EXCEPTION 'activation retry requires its approved backoff and remaining attempts'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- A new independently reviewed intent may supersede blocked or failed history, never an active run.
CREATE FUNCTION app_guard_onboarding_activation_session_request() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE previous property_onboarding_activation_request%ROWTYPE;head property_onboarding_activation_event%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT * INTO previous FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF previous.id IS NOT NULL THEN
  SELECT * INTO head FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=previous.id ORDER BY sequence DESC LIMIT 1;
  IF previous.review_revision_id=NEW.review_revision_id OR head.type NOT IN('BLOCKED','FAILED') THEN RAISE EXCEPTION 'activation requires completion or a fresh Review after blocked or failed history';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER onboarding_activation_session_request_guard BEFORE INSERT ON property_onboarding_activation_request FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_activation_session_request();

CREATE FUNCTION app_guard_onboarding_current_activation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE session uuid;current_id uuid;
BEGIN
 IF NEW.type IN('STARTED','ACTIVATED') THEN
  SELECT session_id INTO session FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND id=NEW.activation_id;
  SELECT id INTO current_id FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND session_id=session ORDER BY created_at DESC,id DESC LIMIT 1;
  IF current_id IS DISTINCT FROM NEW.activation_id THEN RAISE EXCEPTION 'activation execution requires its current session intent';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER onboarding_activation_current_intent_guard BEFORE INSERT ON property_onboarding_activation_event FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_current_activation();

CREATE FUNCTION app_guard_onboarding_operational_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request property_onboarding_activation_request%ROWTYPE;review property_onboarding_revision%ROWTYPE;current_id uuid;property_row property%ROWTYPE;source jsonb;phase property_onboarding_activation_event%ROWTYPE;completion property_onboarding_activation_event%ROWTYPE;kind text;entry jsonb;expected_key text;hash text;owner_version text;owner_tuple text;
BEGIN
 IF NEW.step IS DISTINCT FROM 'ACTIVATE' THEN RETURN NEW;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));source=NEW.source_snapshot;
 SELECT * INTO request FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND id=(source->>'activationId')::uuid;
 IF request.id IS NULL THEN RAISE EXCEPTION 'activation completion requires its actual native intent';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:activation:'||request.id::text,0));
 SELECT * INTO review FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND id=request.review_revision_id;
 SELECT id INTO current_id FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 SELECT * INTO property_row FROM property WHERE organization_id=NEW.organization_id AND id=request.property_id FOR UPDATE;
 SELECT xmin::text,ctid::text INTO owner_version,owner_tuple FROM owner WHERE organization_id=NEW.organization_id AND id=request.owner_id AND archived_at IS NULL;
 hash=encode(digest(convert_to(replace(jsonb_build_array('native-onboarding-completion-v1',NEW.organization_id::text,request.id::text)::text,', ',','),'UTF8'),'sha256'),'hex');expected_key=substring(hash,1,8)||'-'||substring(hash,9,4)||'-5'||substring(hash,14,3)||'-a'||substring(hash,18,3)||'-'||substring(hash,21,12);
 IF NOT coalesce(review.id=current_id AND review.step='REVIEW' AND NEW.previous_id=review.id AND NEW.number=review.number+1 AND NEW.session_id=request.session_id
  AND NEW.owner_id=request.owner_id AND NEW.property_id=request.property_id AND NEW.created_by=request.created_by AND NEW.created_at>=request.created_at
  AND NEW.mode='BACKGROUND' AND NEW.command_key::text=expected_key AND NEW.policy_id=request.policy_id AND NEW.policy_version=request.policy_version AND NEW.policy_snapshot=request.policy_snapshot AND NEW.authorization_cap=request.authorization_cap AND NEW.review_fingerprint=request.review_fingerprint
  AND source->>'source'='CORE_ONBOARDING_PROVEN_ACTIVATION' AND source->>'reviewRevisionId'=review.id::text AND source->>'reviewSourceFingerprint'=review.source_fingerprint AND source->>'requestPayloadSha256'=request.payload_sha256
  AND source-ARRAY['source','activationId','reviewRevisionId','reviewSourceFingerprint','requestPayloadSha256','beforeProperty','afterProperty','effects']='{}'::jsonb
  AND NEW.source_fingerprint=encode(digest(convert_to(app_onboarding_effect_json_text(source),'UTF8'),'sha256'),'hex')
  AND source->'beforeProperty'=jsonb_build_object('id',request.property_id,'xmin',review.source_snapshot#>>'{parent,property,xmin}','tuple',review.source_snapshot#>>'{parent,property,tuple}','status',review.source_snapshot#>>'{parent,property,status}')
  AND source#>>'{beforeProperty,status}' IN('DRAFT','ONBOARDING') AND owner_version=review.source_snapshot#>>'{parent,owner,ownerXmin}' AND owner_tuple=review.source_snapshot#>>'{parent,owner,ownerTuple}'
  AND property_row.status='ACTIVE' AND property_row.archived_at IS NULL
  AND EXISTS(SELECT 1 FROM property p WHERE p.organization_id=NEW.organization_id AND p.id=request.property_id AND p.xmin::text=pg_current_xact_id()::xid::text AND source->'afterProperty'=jsonb_build_object('id',p.id,'xmin',p.xmin::text,'tuple',p.ctid::text,'status',p.status))
  AND (SELECT id FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY created_at DESC,id DESC LIMIT 1)=request.id,false)
 THEN RAISE EXCEPTION 'activation completion requires its consecutive original, unchanged Owner and atomic canonical Property transition';END IF;
 SELECT * INTO completion FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=request.id AND effect_kind IS NULL AND type NOT IN('REQUESTED','ACTIVATED') ORDER BY sequence DESC LIMIT 1;
 IF completion.type IS DISTINCT FROM 'STARTED' THEN RAISE EXCEPTION 'activation completion requires its actual started completion attempt';END IF;
 IF jsonb_typeof(source->'effects') IS DISTINCT FROM 'array' OR jsonb_array_length(source->'effects')<>5 THEN RAISE EXCEPTION 'activation completion requires all five actual phase heads';END IF;
 FOREACH kind IN ARRAY ARRAY['WORKFLOWS','DOCUMENTS','EMAIL','TASKS','NOTIFICATION'] LOOP
  SELECT * INTO phase FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=request.id AND effect_kind=kind ORDER BY sequence DESC LIMIT 1;
  IF phase.type IS DISTINCT FROM 'SUCCEEDED' OR (SELECT count(*) FROM jsonb_array_elements(source->'effects') AS entries(item) WHERE item=jsonb_build_object('eventId',phase.id,'effectKind',kind,'resultFingerprint',phase.result_fingerprint))<>1 THEN RAISE EXCEPTION 'activation completion requires exact successful canonical phase heads';END IF;
  PERFORM app_assert_onboarding_activation_effect(NEW.organization_id,request.id,kind,phase.result,phase.result_fingerprint);
 END LOOP;
 FOR entry IN SELECT item FROM jsonb_array_elements(review.source_snapshot#>'{parent,property,ownership}') AS entries(item) LOOP
  IF NOT EXISTS(SELECT 1 FROM property_owner po WHERE po.organization_id=NEW.organization_id AND po.property_id=request.property_id AND po.id=(entry->>'id')::uuid AND po.archived_at IS NULL AND po.xmin::text=entry->>'xmin' AND po.ctid::text=entry->>'tuple') THEN RAISE EXCEPTION 'activation completion requires unchanged actual ownership';END IF;
 END LOOP;
 IF (SELECT count(*) FROM property_owner WHERE organization_id=NEW.organization_id AND property_id=request.property_id AND archived_at IS NULL)<>jsonb_array_length(review.source_snapshot#>'{parent,property,ownership}') THEN RAISE EXCEPTION 'activation completion requires its complete unchanged ownership collection';END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='property.lifecycle.transition' AND a.resource_type='property' AND a.resource_id=request.property_id AND a.property_scope_id=request.property_id AND a.request_id=NEW.request_id AND a.xmin::text=pg_current_xact_id()::xid::text AND a.before->>'status'='ONBOARDING' AND a.after->>'status'='ACTIVE')
  OR source#>>'{beforeProperty,status}'='DRAFT' AND NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.action='property.lifecycle.transition' AND a.resource_id=request.property_id AND a.request_id=NEW.request_id AND a.xmin::text=pg_current_xact_id()::xid::text AND a.before->>'status'='DRAFT' AND a.after->>'status'='ONBOARDING')
 THEN RAISE EXCEPTION 'activation completion requires the actual complete canonical lifecycle audit chain';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER property_onboarding_operational_revision_guard BEFORE INSERT ON property_onboarding_revision FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_operational_revision();

CREATE FUNCTION app_guard_onboarding_operational_pair() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.step='ACTIVATE' AND NOT EXISTS(SELECT 1 FROM property_onboarding_activation_event e WHERE e.organization_id=NEW.organization_id AND e.activation_id=(NEW.source_snapshot->>'activationId')::uuid AND e.type='ACTIVATED' AND e.result->>'revisionId'=NEW.id::text AND e.occurred_at=NEW.created_at AND e.xmin::text=NEW.xmin::text)
 THEN RAISE EXCEPTION 'activation operational revision requires its atomic completion event';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER property_onboarding_operational_pair_guard AFTER INSERT ON property_onboarding_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_operational_pair();

COMMIT;
