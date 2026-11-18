BEGIN;
-- Resolve original archive evidence through its canonical document_admission.
-- Preserve every applied migration, original document and context receipt.
CREATE OR REPLACE FUNCTION app_maintenance_issue_source_fingerprint(org_uuid uuid,issue_uuid uuid,kind_text text,provider_text text,source_uuid uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE issue operation_issue;task operation_task;property property;source_body jsonb;
BEGIN
 IF org_uuid IS DISTINCT FROM NULLIF(current_setting('app.current_organization_id',true),'')::uuid THEN RETURN NULL;END IF;
 SELECT * INTO issue FROM operation_issue i WHERE i.organization_id=org_uuid AND i.id=issue_uuid;
 SELECT * INTO task FROM operation_task t WHERE t.organization_id=org_uuid AND t.id=issue.task_id AND t.property_id=issue.property_id AND t.archived_at IS NULL;
 SELECT * INTO property FROM property p WHERE p.organization_id=org_uuid AND p.id=issue.property_id AND p.archived_at IS NULL;
 IF issue.id IS NULL OR task.id IS NULL OR property.id IS NULL THEN RETURN NULL;END IF;
 IF kind_text IN('PROPERTY','RESERVATION','GUEST','TASK','PERSON','SUPPLIER','EXPENSE','ASSET') AND provider_text IS NOT NULL THEN RETURN NULL;END IF;
 CASE kind_text
  WHEN 'PROPERTY' THEN SELECT to_jsonb(p) INTO source_body FROM property p WHERE p.organization_id=org_uuid AND p.id=source_uuid AND p.id=issue.property_id AND p.archived_at IS NULL;
  WHEN 'RESERVATION' THEN SELECT to_jsonb(r) INTO source_body FROM reservation r WHERE r.organization_id=org_uuid AND r.id=source_uuid AND r.property_id=issue.property_id AND r.archived_at IS NULL;
  WHEN 'GUEST' THEN SELECT to_jsonb(g) INTO source_body FROM guest g WHERE g.organization_id=org_uuid AND g.id=source_uuid AND g.archived_at IS NULL AND g.merged_into_id IS NULL;
  WHEN 'TASK' THEN SELECT to_jsonb(t) INTO source_body FROM operation_task t WHERE t.organization_id=org_uuid AND t.id=source_uuid AND t.property_id=issue.property_id AND t.archived_at IS NULL;
  WHEN 'PERSON' THEN SELECT to_jsonb(p) INTO source_body FROM person p WHERE p.organization_id=org_uuid AND p.id=source_uuid AND p.archived_at IS NULL;
  WHEN 'SUPPLIER' THEN SELECT to_jsonb(s) INTO source_body FROM supplier s WHERE s.organization_id=org_uuid AND s.id=source_uuid AND s.archived_at IS NULL;
  WHEN 'EXPENSE' THEN SELECT to_jsonb(e) INTO source_body FROM expense e WHERE e.organization_id=org_uuid AND e.id=source_uuid AND e.property_id=issue.property_id;
  WHEN 'ASSET' THEN RETURN NULL; -- F-AST-01 must register its real native asset source.
  WHEN 'PHOTO','DOCUMENT' THEN
   IF kind_text='PHOTO' AND provider_text='FIELD_EVIDENCE' THEN
    SELECT jsonb_build_object('evidence',to_jsonb(e),'task',to_jsonb(t)) INTO source_body FROM operation_task_evidence e
     JOIN operation_task t ON t.organization_id=e.organization_id AND t.id=e.task_id
     WHERE e.organization_id=org_uuid AND e.id=source_uuid AND t.property_id=issue.property_id AND t.archived_at IS NULL
      AND e.storage_key IS NOT NULL AND e.sha256 IS NOT NULL AND e.content_type IN('image/png','image/jpeg','image/webp');
   ELSIF provider_text='DOCUMENT_VERSION' THEN
    SELECT jsonb_build_object('version',to_jsonb(v),'root',to_jsonb(d),'admission',to_jsonb(a)) INTO source_body FROM document_version v
     JOIN document d ON d.organization_id=v.organization_id AND d.id=v.document_id
     JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
     WHERE v.organization_id=org_uuid AND v.id=source_uuid AND(kind_text='DOCUMENT' AND d.kind IN('FILE','INSTANCE') OR kind_text='PHOTO' AND d.kind='FILE') AND d.archived_at IS NULL
      AND(d.property_id IS NULL OR d.property_id=issue.property_id)
      AND(d.reservation_id IS NULL OR EXISTS(SELECT 1 FROM reservation r WHERE r.organization_id=org_uuid AND r.id=d.reservation_id AND r.property_id=issue.property_id))
      AND(kind_text='DOCUMENT' OR a.content_type IN('image/png','image/jpeg','image/webp'));
   ELSE RETURN NULL;END IF;
  ELSE RETURN NULL;
 END CASE;
 IF source_body IS NULL THEN RETURN NULL;END IF;
 RETURN encode(digest(convert_to(jsonb_build_object('issue',to_jsonb(issue),'task',to_jsonb(task),'property',to_jsonb(property),'source',source_body)::text,'UTF8'),'sha256'),'hex');
END $$;


COMMIT;
