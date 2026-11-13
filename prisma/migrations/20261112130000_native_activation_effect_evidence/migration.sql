BEGIN;

-- Effect metadata contains references, ASCII protocol keys and integer versions, never business payloads.
CREATE FUNCTION app_onboarding_effect_json_text(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE kind text;body text;
BEGIN
 kind=jsonb_typeof(value);
 IF kind='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||app_onboarding_effect_json_text(item),',' ORDER BY key COLLATE "C"),'')||'}' INTO body FROM jsonb_each(value) AS entries(key,item);RETURN body;
 ELSIF kind='array' THEN SELECT '['||coalesce(string_agg(app_onboarding_effect_json_text(item),',' ORDER BY position),'')||']' INTO body FROM jsonb_array_elements(value) WITH ORDINALITY AS entries(item,position);RETURN body;
 ELSIF kind='number' THEN IF value::text !~ '^-?(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'activation effect metadata requires integer versions';END IF;
 END IF;
 RETURN value::text;
END $$;

-- ECMAScript trim characters preserve canonical slug identity without changing stored configuration.
CREATE FUNCTION app_onboarding_effect_slug(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;

CREATE FUNCTION app_assert_onboarding_activation_effect(org uuid,activation uuid,kind text,evidence jsonb,checksum text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
    AND definition.version::text=entry->>'version' AND definition.lifecycle='ACTIVE' AND definition.archived_at IS NULL AND definition.created_by=request.created_by
    AND definition.effective_from=source.effective_from AND definition.effective_to IS NOT DISTINCT FROM source.effective_to
    AND definition.reason='onboarding.activation.workflows:'||activation::text||':'||source.id::text
    AND NOT EXISTS(SELECT 1 FROM config_rule later WHERE later.organization_id=org AND later.key=definition.key AND later.scope_type=definition.scope_type AND later.scope_id=definition.scope_id AND later.version>definition.version)
    AND EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=org AND a.actor_id=request.created_by AND a.action='config_rule.version.created' AND a.resource_id=definition.id AND a.after->>'id'=definition.id::text AND a.after->'value'=definition.value),false)
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

CREATE FUNCTION app_guard_onboarding_proven_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE phase property_onboarding_activation_event%ROWTYPE;
BEGIN
 IF NEW.type='SUCCEEDED' THEN PERFORM app_assert_onboarding_activation_effect(NEW.organization_id,NEW.activation_id,NEW.effect_kind,NEW.result,NEW.result_fingerprint);
 ELSIF NEW.type='ACTIVATED' THEN
  FOR phase IN SELECT DISTINCT ON(effect_kind) * FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=NEW.activation_id AND effect_kind IS NOT NULL ORDER BY effect_kind,sequence DESC LOOP
   PERFORM app_assert_onboarding_activation_effect(NEW.organization_id,NEW.activation_id,phase.effect_kind,phase.result,phase.result_fingerprint);
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER onboarding_activation_proven_effect_guard BEFORE INSERT ON property_onboarding_activation_event FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_proven_effect();

-- The existing native guard is replaced below only to preserve its ISO millisecond protocol at completion.
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

COMMIT;
