BEGIN;

-- Extend only the closed native shape. Every original step and its guards remain unchanged.
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
  OR (step='WORKFLOWS' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>8 AND mode='TEMPLATE'))
 AND isfinite(created_at) AND payload_schema_version=1 AND octet_length(encrypted_payload) BETWEEN 64 AND (CASE WHEN step='OWNER' THEN 66304 WHEN step IN('INVENTORY','SERVICES') THEN 4194304 WHEN step='WORKFLOWS' THEN 33554432 ELSE 196608 END)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND length(request_id) BETWEEN 1 AND 1000,false));


-- Additive230 retains every prior migration and native guard byte.
CREATE FUNCTION app_guard_onboarding_workflows_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original property_onboarding_session%ROWTYPE;previous property_onboarding_revision%ROWTYPE;
 target owner%ROWTYPE;property_row property%ROWTYPE;rule config_rule%ROWTYPE;native_rule config_rule%ROWTYPE;
 native_binding property_template_revision%ROWTYPE;latest_binding property_template_revision%ROWTYPE;
 workflows_policy JSONB;minimum_workflows NUMERIC;minimum_tasks NUMERIC;owner_source JSONB;parent_source JSONB;property_source JSONB;ownership_source JSONB;
 owner_xmin TEXT;owner_tuple TEXT;property_xmin TEXT;property_tuple TEXT;manifest JSONB;part JSONB;pin JSONB;
 actual_pin JSONB;actual_templates JSONB;expected_templates JSONB;selected_rule UUID;selected_template UUID;prior_revision INTEGER;
 rule_key TEXT;command_no INTEGER;has_overrides BOOLEAN;expected_action TEXT;item_count INTEGER;
BEGIN
 IF NEW.step IS DISTINCT FROM 'WORKFLOWS' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT * INTO original FROM property_onboarding_session WHERE organization_id=NEW.organization_id AND id=NEW.session_id;
 SELECT * INTO previous FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 IF original.id IS NULL OR previous.id IS NULL OR previous.step NOT IN('SERVICES','WORKFLOWS')
  OR NEW.previous_id IS DISTINCT FROM previous.id OR NEW.number<>previous.number+1
  OR NEW.owner_id IS DISTINCT FROM previous.owner_id OR NEW.property_id IS DISTINCT FROM previous.property_id
  OR NEW.created_at<original.created_at OR NEW.created_at<previous.created_at
 THEN RAISE EXCEPTION 'onboarding Workflows requires its actual consecutive saved Services predecessor'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account WHERE organization_id=NEW.organization_id AND id=NEW.created_by AND status='ACTIVE' AND person_id IS NOT NULL)
 THEN RAISE EXCEPTION 'onboarding Workflows requires its actual active Account and Person'; END IF;
 SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id FOR UPDATE;
 IF rule.id IS NULL OR rule.created_by IS NULL OR rule.key<>'onboarding.wizard' OR rule.scope_type<>'organization' OR rule.scope_id IS NOT NULL
  OR rule.archived_at IS NOT NULL OR rule.lifecycle NOT IN('ACTIVE','RETIRED') OR NEW.created_at<rule.effective_from OR (rule.effective_to IS NOT NULL AND NEW.created_at>=rule.effective_to)
  OR NEW.policy_version<>rule.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
  OR rule.value->>'source' IS DISTINCT FROM 'NATIVE_REVIEWED_PROPERTY_ONBOARDING'
  OR rule.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_NATIVE_ONBOARDING_STEPS' OR rule.value->>'progress' IS DISTINCT FROM 'DERIVED_FROM_NATIVE_RECORDS'
  OR rule.value->>'encryption' IS DISTINCT FROM 'APP_MANAGED_AUTHENTICATED_ENCRYPTION' OR rule.value->>'release' IS DISTINCT FROM 'NATIVE_DELIVERY_READINESS'
 THEN RAISE EXCEPTION 'onboarding Workflows requires its actual approved organization policy'; END IF;

 IF NOT EXISTS(SELECT 1 FROM user_account a JOIN person p ON p.organization_id=a.organization_id AND p.id=a.person_id
  WHERE a.organization_id=NEW.organization_id AND a.id=NEW.created_by AND a.status='ACTIVE' AND p.archived_at IS NULL)
 THEN RAISE EXCEPTION 'onboarding Workflows requires its active canonical Person'; END IF;
 workflows_policy:=rule.value->'workflows';
 IF jsonb_typeof(workflows_policy) IS DISTINCT FROM 'object' OR workflows_policy-ARRAY['modes','minimum_workflows','minimum_tasks']<>'{}'::jsonb
  OR workflows_policy->'modes' IS DISTINCT FROM '["TEMPLATE"]'::jsonb OR NEW.mode<>'TEMPLATE'
  OR jsonb_typeof(workflows_policy->'minimum_workflows') IS DISTINCT FROM 'number'
  OR jsonb_typeof(workflows_policy->'minimum_tasks') IS DISTINCT FROM 'number'
 THEN RAISE EXCEPTION 'onboarding Workflows requires its explicit approved standard-template policy'; END IF;
 minimum_workflows:=(workflows_policy->>'minimum_workflows')::numeric;minimum_tasks:=(workflows_policy->>'minimum_tasks')::numeric;
 IF minimum_workflows<0 OR minimum_workflows>100 OR minimum_workflows<>trunc(minimum_workflows)
  OR minimum_tasks<0 OR minimum_tasks>100 OR minimum_tasks<>trunc(minimum_tasks)
 THEN RAISE EXCEPTION 'onboarding Workflows requires its configured workflow and task minimums'; END IF;
 IF NEW.source_snapshot->>'source' IS DISTINCT FROM 'CORE_PROPERTY_WORKFLOWS'
  OR NEW.source_snapshot-ARRAY['source','parent','workflows','inputFingerprint']<>'{}'::jsonb
  OR NOT coalesce(NEW.source_snapshot->>'inputFingerprint' ~ '^[a-f0-9]{64}$',false)
 THEN RAISE EXCEPTION 'onboarding Workflows requires an identity-only source manifest and exact private input fingerprint'; END IF;
 parent_source:=NEW.source_snapshot->'parent';owner_source:=parent_source->'owner';property_source:=parent_source->'property';
 SELECT * INTO target FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id AND archived_at IS NULL FOR UPDATE;
 SELECT xmin::text,ctid::text INTO owner_xmin,owner_tuple FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id;
 IF target.id IS NULL OR owner_source->>'source' IS DISTINCT FROM 'CORE_OWNER_IDENTITY'
  OR owner_source->>'ownerId' IS DISTINCT FROM target.id::text OR owner_source->>'ownerXmin' IS DISTINCT FROM owner_xmin OR owner_source->>'ownerTuple' IS DISTINCT FROM owner_tuple
  OR (owner_source->>'ownerCreatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.created_at)
  OR (owner_source->>'ownerUpdatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',target.updated_at)
  OR owner_source-ARRAY['source','ownerId','ownerXmin','ownerTuple','ownerCreatedAt','ownerUpdatedAt']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'onboarding Workflows requires its actual active canonical Owner source'; END IF;
 SELECT * INTO property_row FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id AND archived_at IS NULL FOR UPDATE;
 PERFORM id FROM property_owner WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND archived_at IS NULL ORDER BY id FOR UPDATE;
 PERFORM id FROM property_operating_profile WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id FOR UPDATE;
 SELECT xmin::text,ctid::text INTO property_xmin,property_tuple FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',po.id,'ownerId',po.owner_id,'isPrimary',po.is_primary,'xmin',po.xmin::text,'tuple',po.ctid::text) ORDER BY po.owner_id),'[]'::jsonb)
  INTO ownership_source FROM property_owner po WHERE po.organization_id=NEW.organization_id AND po.property_id=NEW.property_id AND po.archived_at IS NULL;
 IF property_row.id IS NULL OR property_row.status NOT IN('DRAFT','ONBOARDING')
  OR NOT EXISTS(SELECT 1 FROM property_owner po WHERE po.organization_id=NEW.organization_id AND po.property_id=NEW.property_id AND po.owner_id=NEW.owner_id AND po.archived_at IS NULL)
  OR parent_source->>'source' IS DISTINCT FROM 'CORE_PROPERTY_IDENTITY' OR parent_source-ARRAY['source','owner','property','initialConfiguration']<>'{}'::jsonb
  OR parent_source->'initialConfiguration' IS DISTINCT FROM 'null'::jsonb
  OR (property_source->>'createdAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',property_row.created_at)
  OR (property_source->>'updatedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',property_row.updated_at)
  OR property_source-ARRAY['createdAt','updatedAt'] IS DISTINCT FROM jsonb_build_object('id',property_row.id,'organizationId',property_row.organization_id,'status',property_row.status,
   'cityId',property_row.city_id,'regionId',property_row.region_id,'createdBy',property_row.created_by,'archivedAt',NULL,'xmin',property_xmin,'tuple',property_tuple,'ownership',ownership_source,
   'operatingProfile',(SELECT jsonb_build_object('id',op.id,'xmin',op.xmin::text,'tuple',op.ctid::text) FROM property_operating_profile op WHERE op.organization_id=NEW.organization_id AND op.property_id=NEW.property_id))
 THEN RAISE EXCEPTION 'onboarding Workflows requires its actual physical, ownership and operating predecessor sources'; END IF;



 manifest:=NEW.source_snapshot->'workflows';
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'object' OR manifest-ARRAY['before','after','commands','templates']<>'{}'::jsonb
  OR NOT(manifest ?& ARRAY['before','after','commands','templates'])
  OR jsonb_typeof(manifest->'templates') IS DISTINCT FROM 'array' OR jsonb_array_length(manifest->'templates') NOT BETWEEN 1 AND 2
  OR jsonb_typeof(manifest->'commands') IS DISTINCT FROM 'object' OR (manifest->'commands')-ARRAY['apply','override']<>'{}'::jsonb
  OR NOT((manifest->'commands') ?& ARRAY['apply','override']) OR jsonb_typeof(manifest#>'{commands,apply}') IS DISTINCT FROM 'object'
  OR jsonb_typeof(manifest#>'{after,binding}') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'onboarding Workflows requires its closed original source and canonical command witnesses'; END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(jsonb_build_array(manifest->'before',manifest->'after')) LOOP
  IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR part-ARRAY['rules','binding']<>'{}'::jsonb OR NOT(part ?& ARRAY['rules','binding'])
   OR jsonb_typeof(part->'rules') IS DISTINCT FROM 'object' OR (part->'rules')-ARRAY['ops.workflows','ops.reservation_task_templates','ops.checklists']<>'{}'::jsonb
   OR NOT((part->'rules') ?& ARRAY['ops.workflows','ops.reservation_task_templates','ops.checklists'])
  THEN RAISE EXCEPTION 'onboarding Workflows requires all three explicit original rule witnesses'; END IF;
  FOREACH rule_key IN ARRAY ARRAY['ops.workflows','ops.reservation_task_templates','ops.checklists'] LOOP
   pin:=part->'rules'->rule_key;
   IF pin IS DISTINCT FROM 'null'::jsonb THEN
    SELECT * INTO native_rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=(pin->>'id')::uuid FOR UPDATE;
    SELECT jsonb_build_object('id',id,'rowVersion',xmin::text,'tuple',ctid::text) INTO actual_pin FROM config_rule WHERE organization_id=NEW.organization_id AND id=native_rule.id;
    IF native_rule.id IS NULL OR native_rule.key<>rule_key OR actual_pin IS DISTINCT FROM pin OR native_rule.created_by IS NULL
     OR native_rule.archived_at IS NOT NULL OR native_rule.lifecycle<>'ACTIVE'
     OR NOT((native_rule.scope_type='organization' AND native_rule.scope_id IS NULL)
      OR(native_rule.scope_type='city' AND native_rule.scope_id=property_row.city_id)
      OR(native_rule.scope_type='owner' AND native_rule.scope_id=NEW.owner_id)
      OR(native_rule.scope_type='property' AND native_rule.scope_id=NEW.property_id)
      OR(native_rule.scope_type='agreement' AND native_rule.scope_id=(SELECT id FROM management_agreement WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND archived_at IS NULL AND status<>'DRAFT' AND effective_from<=NEW.created_at AND(effective_to IS NULL OR effective_to>NEW.created_at) ORDER BY effective_from DESC,id DESC LIMIT 1)))
    THEN RAISE EXCEPTION 'onboarding Workflows requires actual same-tenant original effective-scope rules'; END IF;
   END IF;
  END LOOP;
  pin:=part->'binding';
  IF pin IS DISTINCT FROM 'null'::jsonb THEN
   SELECT * INTO native_binding FROM property_template_revision WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND kind='WORKFLOW' AND id=(pin->>'id')::uuid FOR UPDATE;
   SELECT jsonb_build_object('id',id,'rowVersion',xmin::text,'tuple',ctid::text,'revision',revision,'templateVersionId',template_version_id) INTO actual_pin FROM property_template_revision WHERE organization_id=NEW.organization_id AND id=native_binding.id;
   IF native_binding.id IS NULL OR actual_pin IS DISTINCT FROM pin THEN RAISE EXCEPTION 'onboarding Workflows requires actual original immutable bindings'; END IF;
  END IF;
 END LOOP;
 IF manifest#>'{before,rules,ops.checklists}' IS DISTINCT FROM manifest#>'{after,rules,ops.checklists}'
 THEN RAISE EXCEPTION 'onboarding Workflows cannot rewrite its dependent checklist catalog'; END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]'::jsonb) INTO expected_templates FROM(SELECT DISTINCT jsonb_build_object('id',value->>'templateVersionId') AS value FROM jsonb_array_elements(jsonb_build_array(manifest#>'{before,binding}',manifest#>'{after,binding}')) value WHERE value IS DISTINCT FROM 'null'::jsonb) identities;
 IF(SELECT coalesce(jsonb_agg(jsonb_build_object('id',value->>'id') ORDER BY value->>'id'),'[]'::jsonb) FROM jsonb_array_elements(manifest->'templates')) IS DISTINCT FROM expected_templates
 THEN RAISE EXCEPTION 'onboarding Workflows requires exactly its original bound and selected standard templates'; END IF;
 PERFORM id FROM property_template_version WHERE organization_id=NEW.organization_id AND id IN(SELECT(value->>'id')::uuid FROM jsonb_array_elements(manifest->'templates')) ORDER BY id FOR UPDATE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'rowVersion',xmin::text,'tuple',ctid::text) ORDER BY id),'[]'::jsonb) INTO actual_templates FROM property_template_version
  WHERE organization_id=NEW.organization_id AND kind='WORKFLOW' AND status='ACTIVE' AND(property_id IS NULL OR property_id=NEW.property_id)
   AND id IN(SELECT(value->>'id')::uuid FROM jsonb_array_elements(manifest->'templates'));
 IF actual_templates IS DISTINCT FROM manifest->'templates' THEN RAISE EXCEPTION 'onboarding Workflows requires actual canonical standard-template witnesses'; END IF;
 SELECT * INTO latest_binding FROM property_template_revision WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND kind='WORKFLOW' ORDER BY revision DESC LIMIT 1;
 IF latest_binding.id IS NULL OR latest_binding.id IS DISTINCT FROM(manifest#>>'{after,binding,id}')::uuid THEN RAISE EXCEPTION 'onboarding Workflows requires its actual current canonical binding'; END IF;
 prior_revision:=coalesce((manifest#>>'{before,binding,revision}')::int,0);selected_template:=latest_binding.template_version_id;
 has_overrides:=manifest#>'{commands,override}' IS DISTINCT FROM 'null'::jsonb;
 IF latest_binding.revision<>prior_revision+1+(CASE WHEN has_overrides THEN 1 ELSE 0 END)
  OR manifest#>'{after,binding}' IS DISTINCT FROM(CASE WHEN has_overrides THEN manifest#>'{commands,override}' ELSE manifest#>'{commands,apply}' END)
 THEN RAISE EXCEPTION 'onboarding Workflows requires consecutive original APPLY and optional OVERRIDE revisions'; END IF;
 IF NOT EXISTS(SELECT 1 FROM property_template_version t WHERE t.organization_id=NEW.organization_id AND t.id=selected_template AND t.kind='WORKFLOW' AND t.status='ACTIVE'
  AND(SELECT status FROM property_template_version v WHERE v.organization_id=t.organization_id AND v.key=t.key ORDER BY version DESC LIMIT 1)='ACTIVE')
 THEN RAISE EXCEPTION 'onboarding Workflows requires its actual active selected standard template'; END IF;
 FOR command_no IN 0..(CASE WHEN has_overrides THEN 1 ELSE 0 END) LOOP
  pin:=CASE WHEN command_no=0 THEN manifest#>'{commands,apply}' ELSE manifest#>'{commands,override}' END;
  expected_action:=CASE WHEN command_no=0 THEN 'APPLY' ELSE 'OVERRIDE' END;
  SELECT * INTO native_binding FROM property_template_revision WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND kind='WORKFLOW' AND id=(pin->>'id')::uuid FOR UPDATE;
  SELECT jsonb_build_object('id',id,'rowVersion',xmin::text,'tuple',ctid::text,'revision',revision,'templateVersionId',template_version_id) INTO actual_pin FROM property_template_revision WHERE organization_id=NEW.organization_id AND id=native_binding.id;
  IF native_binding.id IS NULL OR actual_pin IS DISTINCT FROM pin OR native_binding.revision<>prior_revision+command_no+1 OR native_binding.template_version_id<>selected_template
   OR native_binding.action<>expected_action OR native_binding.created_by IS DISTINCT FROM NEW.created_by
   OR(command_no=0 AND native_binding.operation_id IS DISTINCT FROM NEW.command_key)
   OR(command_no=1 AND native_binding.operation_id=NEW.command_key)
   OR native_binding.command->>'action' IS DISTINCT FROM expected_action OR native_binding.command->>'propertyId' IS DISTINCT FROM NEW.property_id::text
   OR native_binding.command->>'ownerId' IS DISTINCT FROM NEW.owner_id::text OR native_binding.command->>'operationId' IS DISTINCT FROM native_binding.operation_id::text
   OR jsonb_typeof(native_binding.command->'expectedRevision') IS DISTINCT FROM 'number'
   OR(native_binding.command->>'expectedRevision')::int IS DISTINCT FROM prior_revision+command_no
   OR native_binding.command->>'reason' IS DISTINCT FROM native_binding.reason
   OR(command_no=0 AND(native_binding.command->>'templateVersionId' IS DISTINCT FROM selected_template::text OR native_binding.command-ARRAY['action','propertyId','ownerId','templateVersionId','expectedRevision','operationId','reason']<>'{}'::jsonb))
   OR(command_no=1 AND(native_binding.command->>'kind' IS DISTINCT FROM 'WORKFLOW' OR jsonb_typeof(native_binding.command->'values') IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(native_binding.command->'values')) NOT BETWEEN 1 AND 500 OR native_binding.command-ARRAY['action','kind','values','propertyId','ownerId','expectedRevision','operationId','reason']<>'{}'::jsonb))
   OR NOT EXISTS(SELECT 1 FROM property_template_revision r JOIN audit_log event ON event.organization_id=r.organization_id AND event.resource_id=r.id
    WHERE r.organization_id=NEW.organization_id AND r.id=native_binding.id AND r.xmin::text=pg_current_xact_id()::xid::text
     AND event.actor_id=NEW.created_by AND event.action='property_template.'||lower(expected_action) AND event.resource_type='property_template_revision' AND event.property_scope_id=NEW.property_id
     AND event.request_id=NEW.request_id AND event.xmin::text=pg_current_xact_id()::xid::text)
  THEN RAISE EXCEPTION 'onboarding Workflows requires its actual atomic canonical commands, creator, nonce and attributed audits'; END IF;
 END LOOP;
 FOREACH rule_key IN ARRAY ARRAY['ops.workflows','ops.reservation_task_templates','ops.checklists'] LOOP
  WITH applicable AS(SELECT c.*,CASE c.scope_type WHEN 'agreement' THEN 5 WHEN 'property' THEN 4 WHEN 'owner' THEN 3 WHEN 'city' THEN 2 ELSE 1 END AS rank
   FROM config_rule c WHERE c.organization_id=NEW.organization_id AND c.key=rule_key AND c.archived_at IS NULL AND c.lifecycle IN('ACTIVE','RETIRED')
    AND c.effective_from<=NEW.created_at AND(c.effective_to IS NULL OR c.effective_to>NEW.created_at)
    AND((c.scope_type='organization' AND c.scope_id IS NULL) OR(c.scope_type='city' AND c.scope_id=property_row.city_id)
     OR(c.scope_type='owner' AND c.scope_id=NEW.owner_id) OR(c.scope_type='property' AND c.scope_id=NEW.property_id)
     OR(c.scope_type='agreement' AND c.scope_id=(SELECT id FROM management_agreement WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND archived_at IS NULL AND status<>'DRAFT' AND effective_from<=NEW.created_at AND(effective_to IS NULL OR effective_to>NEW.created_at) ORDER BY effective_from DESC,id DESC LIMIT 1)))),
   latest_per_scope AS(SELECT DISTINCT ON(scope_type,scope_id) * FROM applicable ORDER BY scope_type,scope_id,effective_from DESC,version DESC)
  SELECT id INTO selected_rule FROM latest_per_scope WHERE lifecycle='ACTIVE' ORDER BY rank DESC,effective_from DESC,version DESC LIMIT 1;
  IF selected_rule IS DISTINCT FROM(manifest#>>ARRAY['after','rules',rule_key,'id'])::uuid THEN RAISE EXCEPTION 'onboarding Workflows must record its actual effective canonical rule result'; END IF;
  IF selected_rule IS NOT NULL THEN
   SELECT * INTO native_rule FROM config_rule WHERE organization_id=NEW.organization_id AND id=selected_rule;
   IF rule_key<>'ops.checklists' AND manifest#>ARRAY['before','rules',rule_key] IS DISTINCT FROM manifest#>ARRAY['after','rules',rule_key]
    AND(native_rule.scope_type<>'property' OR native_rule.scope_id IS DISTINCT FROM NEW.property_id OR native_rule.created_by IS DISTINCT FROM NEW.created_by
     OR NOT EXISTS(SELECT 1 FROM config_rule c JOIN audit_log event ON event.organization_id=c.organization_id AND event.resource_id=c.id
      WHERE c.organization_id=NEW.organization_id AND c.id=selected_rule AND c.xmin::text=pg_current_xact_id()::xid::text
       AND event.actor_id=NEW.created_by AND event.action='config_rule.version.created' AND event.resource_type='config_rule' AND event.property_scope_id=NEW.property_id
       AND event.request_id=NEW.request_id AND event.xmin::text=pg_current_xact_id()::xid::text))
   THEN RAISE EXCEPTION 'changed onboarding Workflow rules require their actual atomic canonical writes and audits'; END IF;
  END IF;
  IF rule_key='ops.workflows' OR rule_key='ops.reservation_task_templates' THEN
   item_count:=0;
   IF selected_rule IS NOT NULL THEN
    IF jsonb_typeof(native_rule.value->(CASE WHEN rule_key='ops.workflows' THEN 'workflows' ELSE 'tasks' END)) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'onboarding Workflows requires actual canonical workflow and task arrays'; END IF;
    item_count:=jsonb_array_length(native_rule.value->(CASE WHEN rule_key='ops.workflows' THEN 'workflows' ELSE 'tasks' END));
   END IF;
   IF item_count>100 OR item_count<(CASE WHEN rule_key='ops.workflows' THEN minimum_workflows ELSE minimum_tasks END)
   THEN RAISE EXCEPTION 'onboarding Workflows must meet its explicitly configured workflow and task counts'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER property_onboarding_workflows_native_guard BEFORE INSERT ON property_onboarding_revision
 FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_workflows_revision();
COMMIT;
