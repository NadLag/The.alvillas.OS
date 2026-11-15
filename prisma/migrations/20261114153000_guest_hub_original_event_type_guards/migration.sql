BEGIN;
-- Preserve immutable native event metadata in both directions. A previously
-- unrelated event cannot acquire a reserved type through an UPDATE.
CREATE OR REPLACE FUNCTION app_guard_guest_hub_event_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type IN('guest_hub.link_issued','guest_hub.link_revoked') THEN RAISE EXCEPTION 'guest_hub_original_event_source_immutable';END IF;
  RETURN OLD;
 END IF;
 IF OLD.type IN('guest_hub.link_issued','guest_hub.link_revoked') OR NEW.type IN('guest_hub.link_issued','guest_hub.link_revoked') THEN
  IF ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at) IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
  THEN RAISE EXCEPTION 'guest_hub_original_event_source_immutable';END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_guard_guest_profile_event_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.type IN('guest_hub.form_grant_recorded','guest_hub.profile_submitted') THEN RAISE EXCEPTION 'guest_profile_original_event_source_immutable';END IF;
  RETURN OLD;
 END IF;
 IF OLD.type IN('guest_hub.form_grant_recorded','guest_hub.profile_submitted') OR NEW.type IN('guest_hub.form_grant_recorded','guest_hub.profile_submitted') THEN
  IF ROW(OLD.id,OLD.organization_id,OLD.type,OLD.payload,OLD.idempotency_key,OLD.occurred_at) IS DISTINCT FROM ROW(NEW.id,NEW.organization_id,NEW.type,NEW.payload,NEW.idempotency_key,NEW.occurred_at)
  THEN RAISE EXCEPTION 'guest_profile_original_event_source_immutable';END IF;
 END IF;
 RETURN NEW;
END $$;
COMMIT;
