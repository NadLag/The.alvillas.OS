-- Reference-only continuations retain the original approved native intent and the shared outbox.
CREATE INDEX onboarding_activation_continuation_org_run_idx
 ON outbox_event(organization_id,(payload->>'activationId'),occurred_at,id)
 WHERE type='onboarding.activation_continue_requested';

CREATE FUNCTION app_guard_onboarding_activation_job_source() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request property_onboarding_activation_request%ROWTYPE;parent outbox_event%ROWTYPE;original outbox_event%ROWTYPE;head property_onboarding_activation_event%ROWTYPE;current_id UUID;activation UUID;minimum TIMESTAMPTZ;bound TIMESTAMPTZ;backoff INTEGER;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type IN('onboarding.activation_requested','onboarding.activation_continue_requested') THEN RAISE EXCEPTION 'native_activation_job_source_immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.type IN('onboarding.activation_requested','onboarding.activation_continue_requested') OR NEW.type IN('onboarding.activation_requested','onboarding.activation_continue_requested') THEN
   IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.type IS DISTINCT FROM OLD.type OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'native_activation_job_source_immutable';END IF;
   IF NEW.type='onboarding.activation_continue_requested' AND NEW.payload->>'notBefore' IS NOT NULL AND NEW.next_attempt_at IS NOT NULL AND NEW.next_attempt_at<(NEW.payload->>'notBefore')::timestamptz THEN RAISE EXCEPTION 'native activation transport cannot precede its immutable due time';END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.type<>'onboarding.activation_continue_requested' THEN RETURN NEW;END IF;
 IF coalesce(jsonb_typeof(NEW.payload)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload))<>4 OR NOT(NEW.payload ?& ARRAY['activationId','sourceOutboxEventId','activationHeadId','notBefore']) OR NEW.status<>'PENDING' OR NEW.processed_at IS NOT NULL OR NEW.attempt_count<>0 OR NEW.last_error IS NOT NULL OR NOT isfinite(NEW.occurred_at),true) THEN RAISE EXCEPTION 'native activation continuation requires its closed queued reference';END IF;
 activation:=(NEW.payload->>'activationId')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:activation-execution:'||activation::text,0));
 SELECT * INTO request FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND id=activation;
 IF request.id IS NULL THEN RAISE EXCEPTION 'native activation continuation requires its actual approved intent';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||request.session_id::text,0));
 SELECT id INTO current_id FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND session_id=request.session_id ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT * INTO head FROM property_onboarding_activation_event WHERE organization_id=NEW.organization_id AND activation_id=request.id ORDER BY sequence DESC LIMIT 1;
 SELECT * INTO original FROM outbox_event WHERE organization_id=NEW.organization_id AND idempotency_key='onboarding.activation:'||request.id::text;
 SELECT * INTO parent FROM outbox_event WHERE organization_id=NEW.organization_id AND id=(NEW.payload->>'sourceOutboxEventId')::uuid;
 IF coalesce(current_id IS DISTINCT FROM request.id OR head.id IS NULL OR head.id IS DISTINCT FROM (NEW.payload->>'activationHeadId')::uuid OR head.type NOT IN('REQUESTED','STARTED','SUCCEEDED','RETRY_SCHEDULED') OR original.id IS NULL OR original.type<>'onboarding.activation_requested' OR original.status='FAILED' OR original.occurred_at<>request.created_at OR original.payload IS DISTINCT FROM jsonb_build_object('sessionId',request.session_id,'activationId',request.id,'reviewRevisionId',request.review_revision_id,'propertyId',request.property_id) OR parent.id IS NULL OR parent.status='FAILED' OR parent.id=NEW.id OR NEW.idempotency_key<>'onboarding.activation.continue:'||parent.id::text OR NEW.occurred_at<parent.occurred_at OR NEW.occurred_at<head.occurred_at,true) THEN RAISE EXCEPTION 'native activation continuation requires its actual current source and phase head';END IF;
 IF parent.type='onboarding.activation_requested' THEN
  IF parent.id<>original.id THEN RAISE EXCEPTION 'native activation continuation requires its original source';END IF;
 ELSIF parent.type='onboarding.activation_continue_requested' THEN
  IF (parent.payload->>'activationId')::uuid IS DISTINCT FROM request.id THEN RAISE EXCEPTION 'native activation continuation cannot cross native intents';END IF;
 ELSE RAISE EXCEPTION 'native activation continuation requires its actual source chain';END IF;
 backoff:=(request.policy_snapshot#>>'{value,activation,retry,backoff_seconds}')::int;
 IF backoff IS NULL OR backoff NOT BETWEEN 1 AND 3600 THEN RAISE EXCEPTION 'native activation continuation requires its original retry policy';END IF;
 minimum:=NULL;
 IF head.type='STARTED' THEN minimum:=NEW.occurred_at+make_interval(secs=>backoff);
 ELSIF head.type='RETRY_SCHEDULED' THEN
  IF head.next_attempt_at IS NULL THEN RAISE EXCEPTION 'native activation continuation requires its actual retry time';END IF;
  IF head.next_attempt_at>NEW.occurred_at THEN minimum:=head.next_attempt_at;END IF;
 END IF;
 IF jsonb_typeof(NEW.payload->'notBefore')='null' THEN
  IF minimum IS NOT NULL OR NEW.next_attempt_at IS NOT NULL THEN RAISE EXCEPTION 'native activation continuation cannot invent an immediate retry';END IF;
 ELSIF jsonb_typeof(NEW.payload->'notBefore')='string' THEN
  IF (NEW.payload->>'notBefore')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RAISE EXCEPTION 'native activation continuation requires its exact UTC due time';END IF;
  bound:=(NEW.payload->>'notBefore')::timestamptz;
  IF NOT isfinite(bound) OR bound<=NEW.occurred_at OR (minimum IS NOT NULL AND bound<minimum) OR NEW.next_attempt_at IS DISTINCT FROM bound THEN RAISE EXCEPTION 'native activation continuation cannot precede its captured policy or reset time';END IF;
 ELSE RAISE EXCEPTION 'native activation continuation requires a closed due time';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER onboarding_activation_job_source_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_activation_job_source();

CREATE FUNCTION app_guard_onboarding_activation_job_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request property_onboarding_activation_request%ROWTYPE;event outbox_event%ROWTYPE;event_xmin TEXT;
BEGIN
 IF NEW.type<>'onboarding.activation_continue_requested' THEN RETURN NULL;END IF;
 SELECT * INTO event FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT xmin::text INTO event_xmin FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
 SELECT * INTO request FROM property_onboarding_activation_request WHERE organization_id=NEW.organization_id AND id=(NEW.payload->>'activationId')::uuid;
 IF request.id IS NULL OR event.id IS NULL OR event_xmin IS DISTINCT FROM pg_current_xact_id()::xid::text OR NOT EXISTS(
  SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=request.created_by AND a.action='onboarding.activation_continuation_requested' AND a.resource_type='onboarding' AND a.resource_id=request.session_id AND a.property_scope_id=request.property_id AND a.occurred_at=NEW.occurred_at AND a.xmin::text=event_xmin AND length(a.request_id) BETWEEN 1 AND 1000
  AND a.after=NEW.payload||jsonb_build_object('outboxEventId',NEW.id)
 ) THEN RAISE EXCEPTION 'native activation continuation requires its atomic original-principal audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER onboarding_activation_job_birth_guard AFTER INSERT ON outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_activation_job_birth();
