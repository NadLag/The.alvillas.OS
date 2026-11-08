-- Forward extension: retain every earlier stage predicate and keep Go Live closed.
CREATE OR REPLACE FUNCTION app_guard_lead_stage_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
  rule config_rule%ROWTYPE; original lead%ROWTYPE; predecessor lead_stage_revision%ROWTYPE;
  edge jsonb; proof jsonb; required_kind text; from_rank integer; to_rank integer;
  stages text[]:=ARRAY['NEW','CONTACTED','QUALIFIED','PROPERTY_ASSESSMENT','PROPOSAL','CONTRACT_DRAFT','SENT','VIEWED','SIGNED','ALVILLAS_ONBOARDING','GO_LIVE'];
  proof_kinds text[]:=ARRAY['PROPOSAL_VERSION','CONTRACT_VERSION','SIGNATURE_SENT','SIGNATURE_VIEWED','SIGNATURE_SIGNED_ARCHIVE','OWNER_CONVERSION','ONBOARDING_RELEASE'];
BEGIN
  SELECT * INTO original FROM lead WHERE organization_id=NEW.organization_id AND id=NEW.lead_id;
  IF original.id IS NULL OR original.created_at>NEW.created_at THEN RAISE EXCEPTION 'lead stage requires its actual original tenant capture'; END IF;
  IF NEW.previous_id IS NULL THEN
    IF NEW.number<>1 OR NEW.from_stage<>original.initial_stage THEN RAISE EXCEPTION 'lead stage requires its exact original position'; END IF;
  ELSE
    SELECT * INTO predecessor FROM lead_stage_revision WHERE organization_id=NEW.organization_id AND lead_id=NEW.lead_id AND id=NEW.previous_id;
    IF predecessor.id IS NULL OR NEW.number<>predecessor.number+1 OR NEW.from_stage<>predecessor.to_stage OR NEW.created_at<predecessor.created_at
    THEN RAISE EXCEPTION 'lead stage requires its exact immutable predecessor'; END IF;
  END IF;
  from_rank:=array_position(stages,NEW.from_stage);to_rank:=array_position(stages,NEW.to_stage);
  IF (NEW.kind='ADVANCE' AND to_rank<>from_rank+1) OR (NEW.kind='CORRECTION' AND to_rank>=from_rank)
  THEN RAISE EXCEPTION 'lead stage requires an ordered advance or explicit backward correction'; END IF;
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id;
  IF rule.id IS NULL OR rule.key<>'crm.pipeline' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
    OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED')
    OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
    OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
    OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_IMMUTABLE_LEAD_PIPELINE' OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_STAGE_MOVEMENTS'
  THEN RAISE EXCEPTION 'lead stage requires its actual organization pipeline policy'; END IF;
  SELECT item.value INTO edge FROM jsonb_array_elements(rule.value->'transitions') AS item(value)
    WHERE item.value->>'from'=NEW.from_stage AND item.value->>'to'=NEW.to_stage AND item.value->>'kind'=NEW.kind;
  IF edge IS NULL OR jsonb_typeof(edge->'evidence') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'lead stage requires an explicitly configured transition'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(NEW.evidence))<>(SELECT count(DISTINCT value->>'kind') FROM jsonb_array_elements(NEW.evidence))
  THEN RAISE EXCEPTION 'lead stage proof kinds must be distinct'; END IF;
  IF to_rank>4 THEN
    FOREACH required_kind IN ARRAY proof_kinds[1:to_rank-4] LOOP
      IF NOT(edge->'evidence' ? required_kind) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence) AS e(value) WHERE e.value->>'kind'=required_kind)
      THEN RAISE EXCEPTION 'lead stage requires its actual mandatory native source evidence'; END IF;
    END LOOP;
  END IF;
  FOR required_kind IN SELECT jsonb_array_elements_text(edge->'evidence') LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence) AS e(value) WHERE e.value->>'kind'=required_kind)
    THEN RAISE EXCEPTION 'lead stage requires every configured native source proof'; END IF;
  END LOOP;
  FOR proof IN SELECT value FROM jsonb_array_elements(NEW.evidence) LOOP
    IF NOT coalesce(proof->>'organizationId'=NEW.organization_id::text AND proof->>'leadId'=NEW.lead_id::text
      AND proof->>'kind'=ANY(proof_kinds) AND edge->'evidence' ? (proof->>'kind')
      AND proof->>'sourceFingerprint' ~ '^[a-f0-9]{64}$' AND (proof->>'occurredAt')::timestamptz<=NEW.created_at,false)
    THEN RAISE EXCEPTION 'lead stage proof requires its exact tenant lead native source and time'; END IF;
    IF proof->>'kind' IN('PROPOSAL_VERSION','CONTRACT_VERSION') THEN
      IF NOT EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.organization_id=v.organization_id AND d.id=v.document_id
        JOIN document_admission admission ON admission.organization_id=v.organization_id AND admission.id=v.admission_id
        WHERE v.organization_id=NEW.organization_id AND v.id=(proof->>'sourceId')::uuid
        AND d.source_kind='LEAD' AND d.source_id=NEW.lead_id AND d.kind='INSTANCE' AND d.archived_at IS NULL
        AND (rule.value->'document_types'->CASE WHEN proof->>'kind'='PROPOSAL_VERSION' THEN 'proposal' ELSE 'contract' END) ? d.type_key
        AND admission.content_type='application/pdf' AND v.created_at<=NEW.created_at AND (v.effective_from IS NULL OR v.effective_from<=NEW.created_at)
        AND NOT EXISTS(SELECT 1 FROM document_version later WHERE later.organization_id=v.organization_id AND later.document_id=v.document_id AND later.number>v.number
          AND later.created_at<=NEW.created_at AND (later.effective_from IS NULL OR later.effective_from<=NEW.created_at)))
      THEN RAISE EXCEPTION 'lead stage requires its actual effective native proposal or contract original'; END IF;
    ELSIF proof->>'kind' IN('SIGNATURE_SENT','SIGNATURE_VIEWED') THEN
      IF NOT EXISTS(SELECT 1 FROM signature_event e JOIN signature s ON s.organization_id=e.organization_id AND s.id=e.signature_id
        JOIN document_version v ON v.organization_id=s.organization_id AND v.id=s.document_version_id JOIN document d ON d.organization_id=v.organization_id AND d.id=v.document_id
        WHERE e.organization_id=NEW.organization_id AND e.id=(proof->>'sourceId')::uuid AND d.source_kind='LEAD' AND d.source_id=NEW.lead_id
        AND d.archived_at IS NULL AND (rule.value->'document_types'->'contract') ? d.type_key
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence) AS bound(value) WHERE bound.value->>'kind'='CONTRACT_VERSION' AND bound.value->>'sourceId'=s.document_version_id::text)
        AND (proof->>'kind'='SIGNATURE_SENT' OR EXISTS(SELECT 1 FROM signature_event sent JOIN jsonb_array_elements(NEW.evidence) AS bound(value)
          ON bound.value->>'kind'='SIGNATURE_SENT' AND bound.value->>'sourceId'=sent.id::text
          WHERE sent.organization_id=NEW.organization_id AND sent.signature_id=s.id))
        AND e.state=CASE WHEN proof->>'kind'='SIGNATURE_SENT' THEN 'SENT' ELSE 'VIEWED' END AND e.provider_evidence_id IS NOT NULL AND e.observed_at<=NEW.created_at)
      THEN RAISE EXCEPTION 'lead stage requires actual authenticated signature distribution or viewing evidence'; END IF;
    ELSIF proof->>'kind'='SIGNATURE_SIGNED_ARCHIVE' THEN
      IF NOT EXISTS(SELECT 1 FROM signature_signed_archive a JOIN signature s ON s.organization_id=a.organization_id AND s.id=a.signature_id
        JOIN document_version v ON v.organization_id=s.organization_id AND v.id=s.document_version_id JOIN document d ON d.organization_id=v.organization_id AND d.id=v.document_id
        JOIN signature_event e ON e.organization_id=a.organization_id AND e.signature_id=a.signature_id AND e.state='SIGNED' AND e.provider_evidence_id IS NOT NULL
        WHERE a.organization_id=NEW.organization_id AND a.id=(proof->>'sourceId')::uuid AND d.source_kind='LEAD' AND d.source_id=NEW.lead_id
        AND d.archived_at IS NULL AND (rule.value->'document_types'->'contract') ? d.type_key AND a.admitted_at<=NEW.created_at AND e.observed_at<=NEW.created_at
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence) AS bound(value) WHERE bound.value->>'kind'='CONTRACT_VERSION' AND bound.value->>'sourceId'=s.document_version_id::text)
        AND EXISTS(SELECT 1 FROM signature_event sent JOIN jsonb_array_elements(NEW.evidence) AS bound(value)
          ON bound.value->>'kind'='SIGNATURE_SENT' AND bound.value->>'sourceId'=sent.id::text WHERE sent.organization_id=NEW.organization_id AND sent.signature_id=a.signature_id)
        AND EXISTS(SELECT 1 FROM signature_event viewed JOIN jsonb_array_elements(NEW.evidence) AS bound(value)
          ON bound.value->>'kind'='SIGNATURE_VIEWED' AND bound.value->>'sourceId'=viewed.id::text WHERE viewed.organization_id=NEW.organization_id AND viewed.signature_id=a.signature_id)
        AND EXISTS(SELECT 1 FROM signature_signed_artifact artifact WHERE artifact.organization_id=a.organization_id AND artifact.archive_id=a.id))
      THEN RAISE EXCEPTION 'lead stage requires its actual completed immutable signed archive'; END IF;
    ELSIF proof->>'kind'='OWNER_CONVERSION' THEN
      IF NOT EXISTS(SELECT 1 FROM lead_conversion c JOIN owner o ON o.organization_id=c.organization_id AND o.id=c.owner_id
        WHERE c.organization_id=NEW.organization_id AND c.id=(proof->>'sourceId')::uuid AND c.lead_id=NEW.lead_id
        AND c.created_at<=NEW.created_at AND o.archived_at IS NULL
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence) bound(value)
          WHERE bound.value->>'kind'='SIGNATURE_SIGNED_ARCHIVE' AND bound.value->>'sourceId'=c.signed_archive_id::text))
      THEN RAISE EXCEPTION 'lead stage requires its actual native owner conversion and original signed archive'; END IF;
    ELSE
      RAISE EXCEPTION 'lead stage requires native conversion and onboarding release acceptance from its dependent feature';
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='lead' AND l.resource_id=NEW.lead_id
    AND l.action='crm.lead_stage_recorded' AND l.actor_id=NEW.created_by AND l.request_id=NEW.request_id AND l.occurred_at=NEW.created_at
    AND l.after->>'revisionId'=NEW.id::text AND l.after->>'leadId'=NEW.lead_id::text AND l.after->>'fromStage'=NEW.from_stage AND l.after->>'toStage'=NEW.to_stage
    AND l.after->>'commandHash'=NEW.command_hash AND l.after->>'reasonSha256'=NEW.reason_sha256 AND l.after->>'policyId'=NEW.policy_id::text
    AND l.xmin::text=pg_current_xact_id()::xid::text AND NEW.xmin::text=l.xmin::text)
  THEN RAISE EXCEPTION 'lead stage requires its atomic private actor audit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='crm.lead_stage_recorded'
    AND e.idempotency_key='crm.lead.stage:'||NEW.id::text AND e.payload=jsonb_build_object('leadId',NEW.lead_id,'revisionId',NEW.id,'fromStage',NEW.from_stage,'toStage',NEW.to_stage)
    AND e.occurred_at=NEW.created_at AND e.xmin::text=NEW.xmin::text)
  THEN RAISE EXCEPTION 'lead stage requires its atomic identifier-only outbox'; END IF;
  RETURN NULL;
END $$;
