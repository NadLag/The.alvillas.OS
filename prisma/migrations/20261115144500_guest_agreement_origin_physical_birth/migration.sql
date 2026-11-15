BEGIN;
-- A PL/pgSQL composite does not reliably retain an inserted heap tuple's xmin.
-- Read the actual native intent row while preserving every original birth check.
CREATE OR REPLACE FUNCTION app_guard_guest_agreement_origin_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE request guest_hub_agreement_request%ROWTYPE;release guest_hub_agreement_release%ROWTYPE;intent signature_provider_intent%ROWTYPE;head UUID;
BEGIN
 SELECT * INTO request FROM guest_hub_agreement_request WHERE organization_id=NEW.organization_id AND id=NEW.guest_request_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('guest-hub-link:'||NEW.organization_id::text||':'||request.link_id::text,0));
 SELECT * INTO release FROM guest_hub_agreement_release WHERE organization_id=NEW.organization_id AND id=request.release_id;
 SELECT id INTO head FROM guest_hub_agreement_release WHERE organization_id=NEW.organization_id AND link_id=request.link_id ORDER BY version DESC LIMIT 1;
 SELECT * INTO intent FROM signature_provider_intent WHERE organization_id=NEW.organization_id AND id=NEW.distribution_intent_id;
 IF NOT coalesce(request.id IS NOT NULL AND release.id=head AND release.decision='GRANTED' AND NEW.created_at<release.expires_at
  AND NOT EXISTS(SELECT 1 FROM guest_hub_link_revocation WHERE organization_id=NEW.organization_id AND link_id=request.link_id)
  AND app_guest_profile_actual_source(NEW.organization_id,request.reservation_id,request.property_id,request.guest_id,request.source_snapshot)
  AND intent.id IS NOT NULL AND intent.phase='SEND' AND intent.command_key=request.id AND intent.requested_by=NEW.delegated_by AND release.created_by=NEW.delegated_by
  AND intent.requested_at=NEW.created_at AND NEW.created_at>=request.created_at AND intent.input->'guestAgreement'=NEW.provenance
  AND NEW.provenance=jsonb_build_object('protocol','NATIVE_GUEST_AGREEMENT_DISTRIBUTION_ORIGIN_V1','organizationId',NEW.organization_id::text,'guestRequestId',request.id::text,'linkId',request.link_id::text,'releaseId',request.release_id::text,'preparationId',request.preparation_id::text,'reservationId',request.reservation_id::text,'propertyId',request.property_id::text,'guestId',request.guest_id::text,'delegatedBy',release.created_by::text,'releaseFingerprint',request.release_fingerprint,'originalFingerprint',request.original_fingerprint,'payloadSha256',request.payload_sha256)
  AND intent.input->>'preparationId'=request.preparation_id::text AND EXISTS(SELECT 1 FROM signature_provider_intent physical WHERE physical.organization_id=NEW.organization_id AND physical.id=NEW.distribution_intent_id AND physical.xmin::text=pg_current_xact_id()::xid::text),false)
 THEN RAISE EXCEPTION 'guest_agreement_document_origin_requires_its_atomic_exact_native_distribution';END IF;
 RETURN NULL;
END $$;
COMMIT;
