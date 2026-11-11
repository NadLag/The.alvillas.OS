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
  OR (step='REVIEW' AND property_id IS NOT NULL AND previous_id IS NOT NULL AND number>9 AND mode='VALIDATE'))
 AND isfinite(created_at) AND payload_schema_version=1
 AND octet_length(encrypted_payload) BETWEEN 64 AND (CASE WHEN step='OWNER' THEN 66304 WHEN step IN('INVENTORY','SERVICES') THEN 4194304 WHEN step='WORKFLOWS' THEN 33554432 WHEN step='REVIEW' THEN 134217728 ELSE 196608 END)
 AND command_hash ~ '^[a-f0-9]{64}$' AND review_fingerprint ~ '^[a-f0-9]{64}$' AND source_fingerprint ~ '^[a-f0-9]{64}$'
 AND payload_sha256=encode(sha256(encrypted_payload),'hex') AND policy_version>0
 AND jsonb_typeof(source_snapshot)='object' AND jsonb_typeof(policy_snapshot)='object' AND jsonb_typeof(authorization_cap)='object'
 AND length(request_id) BETWEEN 1 AND 1000,false));

-- This invoker-only helper retains tenant RLS and locks actual source tuples. It cannot write source data.
CREATE FUNCTION app_assert_onboarding_configuration_pin(organization UUID,relation_name TEXT,pin JSONB) RETURNS void
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actual_version TEXT;actual_tuple TEXT;
BEGIN
 IF relation_name NOT IN('owner','property','property_owner','property_operating_profile','property_onboarding_revision','management_agreement','config_rule','role_assignment','person','user_account','role','property_template_version','property_template_revision','booking_channel')
  OR jsonb_typeof(pin) IS DISTINCT FROM 'object' OR NOT coalesce(pin->>'id' ~ '^[a-fA-F0-9-]{36}$',false)
  OR NOT coalesce(pin->>'rowVersion' ~ '^[0-9]+$',false) OR NOT coalesce(pin->>'tuple' ~ '^\([0-9]+,[0-9]+\)$',false)
 THEN RAISE EXCEPTION 'whole configuration Review requires an actual permitted source identity and tuple'; END IF;
 EXECUTE format('SELECT xmin::text,ctid::text FROM %I WHERE organization_id=$1 AND id=$2 FOR SHARE',relation_name)
  INTO actual_version,actual_tuple USING organization,(pin->>'id')::uuid;
 IF actual_version IS DISTINCT FROM pin->>'rowVersion' OR actual_tuple IS DISTINCT FROM pin->>'tuple'
 THEN RAISE EXCEPTION 'whole configuration Review source changed or belongs to another organization'; END IF;
END $$;

CREATE FUNCTION app_guard_onboarding_configuration_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE previous property_onboarding_revision%ROWTYPE;policy config_rule%ROWTYPE;target owner%ROWTYPE;physical property%ROWTYPE;
 agreement management_agreement%ROWTYPE;source JSONB;parent JSONB;pin JSONB;part JSONB;item JSONB;actual JSONB;selected UUID;
 binding property_template_revision%ROWTYPE;configuration config_rule%ROWTYPE;template property_template_version%ROWTYPE;
 key_name TEXT;family TEXT;field TEXT;column_name TEXT;value JSONB;review_review_role_id UUID;signature TEXT;permission_count INTEGER;
 team_ids JSONB;channel_ids JSONB;actual_ids JSONB;minimum_count NUMERIC;actual_count INTEGER;
BEGIN
 IF NEW.step IS DISTINCT FROM 'REVIEW' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':onboarding:session:'||NEW.session_id::text,0));
 SELECT * INTO previous FROM property_onboarding_revision WHERE organization_id=NEW.organization_id AND session_id=NEW.session_id ORDER BY number DESC LIMIT 1;
 IF previous.id IS NULL OR previous.step NOT IN('WORKFLOWS','REVIEW') OR NEW.previous_id IS DISTINCT FROM previous.id
  OR NEW.number<>previous.number+1 OR NEW.owner_id IS DISTINCT FROM previous.owner_id OR NEW.property_id IS DISTINCT FROM previous.property_id
  OR NEW.created_at<previous.created_at OR NEW.mode<>'VALIDATE'
 THEN RAISE EXCEPTION 'whole configuration Review requires its actual consecutive saved Workflows predecessor'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_account a JOIN person p ON p.organization_id=a.organization_id AND p.id=a.person_id
  WHERE a.organization_id=NEW.organization_id AND a.id=NEW.created_by AND a.status='ACTIVE' AND p.archived_at IS NULL)
 THEN RAISE EXCEPTION 'whole configuration Review requires its active canonical Account and Person'; END IF;
 SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.policy_id FOR SHARE;
 IF policy.id IS NULL OR policy.created_by IS NULL OR policy.key<>'onboarding.wizard' OR policy.scope_type<>'organization' OR policy.scope_id IS NOT NULL
  OR policy.archived_at IS NOT NULL OR policy.lifecycle NOT IN('ACTIVE','RETIRED') OR NEW.created_at<policy.effective_from OR (policy.effective_to IS NOT NULL AND NEW.created_at>=policy.effective_to)
  OR NEW.policy_version<>policy.version OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',policy.id,'version',policy.version,'value',policy.value)
  OR policy.value->>'source' IS DISTINCT FROM 'NATIVE_REVIEWED_PROPERTY_ONBOARDING'
  OR policy.value->>'history' IS DISTINCT FROM 'APPEND_ONLY_NATIVE_ONBOARDING_STEPS'
  OR policy.value->>'progress' IS DISTINCT FROM 'DERIVED_FROM_NATIVE_RECORDS'
  OR policy.value->>'encryption' IS DISTINCT FROM 'APP_MANAGED_AUTHENTICATED_ENCRYPTION'
  OR policy.value->>'release' IS DISTINCT FROM 'NATIVE_DELIVERY_READINESS'
  OR policy.value#>'{review,modes}' IS DISTINCT FROM '["VALIDATE"]'::jsonb
  OR jsonb_typeof(policy.value#>'{review,required_owner_fields}') IS DISTINCT FROM 'array'
  OR jsonb_typeof(policy.value#>'{review,required_property_fields}') IS DISTINCT FROM 'array'
  OR (policy.value->'review')-ARRAY['modes','required_owner_fields','required_property_fields']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'whole configuration Review requires its explicit actual approved completeness policy'; END IF;
 source:=NEW.source_snapshot;parent:=source->'parent';
 IF source->>'source' IS DISTINCT FROM 'CORE_ONBOARDING_COMPLETE_CONFIGURATION'
  OR source-ARRAY['source','parent','ancestry','agreement','agreementRules','operatingProfileHead','operatingRule','team','bookingChannels','inventory','services','workflows']<>'{}'::jsonb
  OR parent->>'source' IS DISTINCT FROM 'CORE_PROPERTY_IDENTITY' OR jsonb_array_length(source->'ancestry')<>9
 THEN RAISE EXCEPTION 'whole configuration Review requires its exact identity-only native source manifest'; END IF;
 SELECT * INTO target FROM owner WHERE organization_id=NEW.organization_id AND id=NEW.owner_id AND archived_at IS NULL;
 SELECT * INTO physical FROM property WHERE organization_id=NEW.organization_id AND id=NEW.property_id AND archived_at IS NULL;
 IF target.id IS NULL OR physical.id IS NULL OR physical.status NOT IN('DRAFT','ONBOARDING')
  OR parent#>>'{owner,ownerId}' IS DISTINCT FROM target.id::text OR parent#>>'{property,id}' IS DISTINCT FROM physical.id::text
  OR NOT EXISTS(SELECT 1 FROM property_owner WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND owner_id=NEW.owner_id AND archived_at IS NULL)
 THEN RAISE EXCEPTION 'whole configuration Review requires its actual original Owner and unactivated Property'; END IF;
 PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'owner',jsonb_build_object('id',target.id,'rowVersion',parent#>>'{owner,ownerXmin}','tuple',parent#>>'{owner,ownerTuple}'));
 PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'property',jsonb_build_object('id',physical.id,'rowVersion',parent#>>'{property,xmin}','tuple',parent#>>'{property,tuple}'));
 FOR pin IN SELECT * FROM jsonb_array_elements(parent#>'{property,ownership}') LOOP
  PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'property_owner',jsonb_build_object('id',pin->>'id','rowVersion',pin->>'xmin','tuple',pin->>'tuple'));
 END LOOP;
 FOR pin IN SELECT * FROM jsonb_array_elements(source->'ancestry') LOOP
  PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'property_onboarding_revision',pin);
  SELECT jsonb_build_object('id',r.id,'previousId',r.previous_id,'step',r.step,'number',r.number,'ownerId',r.owner_id,'propertyId',r.property_id,'mode',r.mode,'createdBy',r.created_by,'sourceFingerprint',r.source_fingerprint,'sourceSnapshot',r.source_snapshot,'payloadSha256',r.payload_sha256,'rowVersion',r.xmin::text,'tuple',r.ctid::text)
   INTO actual FROM property_onboarding_revision r WHERE r.organization_id=NEW.organization_id AND r.session_id=NEW.session_id AND r.step=pin->>'step' AND r.number<=previous.number ORDER BY r.number DESC LIMIT 1;
  IF actual IS DISTINCT FROM pin-'createdAt' OR pin->>'step' NOT IN('OWNER','PROPERTY','OPERATING_PROFILE','MANAGEMENT_AGREEMENT','TEAM','BOOKING_CHANNELS','INVENTORY','SERVICES','WORKFLOWS')
  THEN RAISE EXCEPTION 'whole configuration Review requires every actual latest native predecessor'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT source_head->>'step') FROM jsonb_array_elements(source->'ancestry') source_head)<>9
 THEN RAISE EXCEPTION 'whole configuration Review cannot duplicate native predecessor families'; END IF;
 FOR field IN SELECT jsonb_array_elements_text(policy.value#>'{review,required_owner_fields}') LOOP
  column_name:=CASE field WHEN 'displayName' THEN 'display_name' WHEN 'email' THEN 'email' WHEN 'phone' THEN 'phone' WHEN 'preferredLocale' THEN 'preferred_locale' END;
  IF column_name IS NULL THEN RAISE EXCEPTION 'whole configuration Review completeness field is not registered'; END IF;
  value:=to_jsonb(target)->column_name;
  IF value IS NULL OR value='null'::jsonb OR (jsonb_typeof(value)='string' AND btrim(value#>>'{}')='')
  THEN RAISE EXCEPTION 'whole configuration Review requires its configured Owner fields'; END IF;
 END LOOP;
 FOR field IN SELECT jsonb_array_elements_text(policy.value#>'{review,required_property_fields}') LOOP
  column_name:=CASE field WHEN 'name' THEN 'name' WHEN 'addressLine1' THEN 'address_line_1' WHEN 'addressLine2' THEN 'address_line_2' WHEN 'cityId' THEN 'city_id' WHEN 'regionId' THEN 'region_id' WHEN 'city' THEN 'city' WHEN 'region' THEN 'region' WHEN 'countryCode' THEN 'country_code' WHEN 'propertyType' THEN 'property_type' WHEN 'bedrooms' THEN 'bedrooms' WHEN 'bathrooms' THEN 'bathrooms' WHEN 'livingSpaces' THEN 'living_spaces' WHEN 'parkingSpaces' THEN 'parking_spaces' WHEN 'maxGuests' THEN 'max_guests' WHEN 'hasPool' THEN 'has_pool' WHEN 'hasGarden' THEN 'has_garden' WHEN 'timezone' THEN 'timezone' WHEN 'amenities' THEN 'amenities' WHEN 'photoUrls' THEN 'photo_urls' END;
  IF column_name IS NULL THEN RAISE EXCEPTION 'whole configuration Review completeness field is not registered'; END IF;
  value:=to_jsonb(physical)->column_name;
  IF value IS NULL OR value='null'::jsonb OR (jsonb_typeof(value)='string' AND btrim(value#>>'{}')='') OR value='[]'::jsonb
  THEN RAISE EXCEPTION 'whole configuration Review requires its configured Property fields'; END IF;
 END LOOP;
 pin:=source->'operatingProfileHead';
 PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'property_operating_profile',jsonb_build_object('id',pin->>'id','rowVersion',pin->>'xmin','tuple',pin->>'tuple'));
 IF NOT EXISTS(SELECT 1 FROM property_operating_profile p WHERE p.organization_id=NEW.organization_id AND p.id=(pin->>'id')::uuid AND p.property_id=NEW.property_id)
 THEN RAISE EXCEPTION 'whole configuration Review requires its actual current operating profile'; END IF;
 pin:=source->'agreement';
 PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'management_agreement',jsonb_build_object('id',pin->>'id','rowVersion',pin->>'xmin','tuple',pin->>'tuple'));
 SELECT * INTO agreement FROM management_agreement WHERE organization_id=NEW.organization_id AND id=(pin->>'id')::uuid;
 IF agreement.property_id IS DISTINCT FROM NEW.property_id OR agreement.archived_at IS NOT NULL OR agreement.status='ENDED' OR (agreement.effective_to IS NOT NULL AND agreement.effective_to<=NEW.created_at)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source->'ancestry') a WHERE a->>'step'='MANAGEMENT_AGREEMENT' AND a#>>'{sourceSnapshot,agreement,id}'=agreement.id::text)
 THEN RAISE EXCEPTION 'whole configuration Review requires its actual current selected Management Agreement'; END IF;
 FOR pin IN SELECT * FROM jsonb_array_elements(source->'agreementRules') LOOP
  PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'config_rule',jsonb_build_object('id',pin->>'id','rowVersion',pin->>'xmin','tuple',pin->>'tuple'));
  SELECT * INTO configuration FROM config_rule WHERE organization_id=NEW.organization_id AND id=(pin->>'id')::uuid;
  IF configuration.scope_type<>'agreement' OR configuration.scope_id IS DISTINCT FROM agreement.id OR configuration.archived_at IS NOT NULL OR configuration.created_by IS NULL OR configuration.lifecycle NOT IN('DRAFT','ACTIVE')
   OR configuration.id IS DISTINCT FROM(SELECT id FROM config_rule WHERE organization_id=NEW.organization_id AND scope_type='agreement' AND scope_id=agreement.id AND key=configuration.key AND archived_at IS NULL ORDER BY version DESC LIMIT 1)
  THEN RAISE EXCEPTION 'whole configuration Review requires its actual current attributable Agreement rules'; END IF;
 END LOOP;
 IF jsonb_array_length(source->'agreementRules')<>7
  OR (SELECT count(DISTINCT r->>'key') FROM jsonb_array_elements(source->'agreementRules') r)<>7
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(source->'agreementRules') r WHERE r->>'key' NOT IN('finance.commission','finance.expense_treatment','finance.approval_thresholds','finance.payout_schedule','agreement.responsibilities','agreement.notice','agreement.special_conditions'))
 THEN RAISE EXCEPTION 'whole configuration Review requires all registered Agreement groups exactly once'; END IF;
 team_ids:='[]'::jsonb;
 FOR part IN SELECT * FROM jsonb_array_elements(source#>'{team,pins}') LOOP
  IF part-ARRAY['assignments','people','accounts','roles']<>'{}'::jsonb THEN RAISE EXCEPTION 'whole configuration Team manifest contains unregistered values'; END IF;
  FOR pin IN SELECT * FROM jsonb_array_elements(part->'assignments') LOOP
   PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'role_assignment',pin);
   IF pin-ARRAY['id','rowVersion','tuple','personId','roleId','userAccountId','scopeType','scopeId']<>'{}'::jsonb
    OR NOT EXISTS(SELECT 1 FROM role_assignment a JOIN person p ON p.organization_id=a.organization_id AND p.id=a.person_id
     JOIN role r ON r.organization_id=a.organization_id AND r.id=a.role_id
     WHERE a.organization_id=NEW.organization_id AND a.id=(pin->>'id')::uuid AND a.scope_type='property' AND a.scope_id=NEW.property_id
      AND a.archived_at IS NULL AND a.valid_from<=NEW.created_at AND(a.valid_to IS NULL OR a.valid_to>NEW.created_at)
      AND p.archived_at IS NULL AND r.archived_at IS NULL AND a.person_id::text=pin->>'personId' AND a.role_id::text=pin->>'roleId'
      AND a.user_account_id IS NOT DISTINCT FROM(pin->>'userAccountId')::uuid
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(part->'people') q WHERE q->>'id'=a.person_id::text)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(part->'roles') q WHERE q->>'id'=a.role_id::text)
      AND(a.user_account_id IS NULL OR EXISTS(SELECT 1 FROM user_account u WHERE u.organization_id=a.organization_id AND u.id=a.user_account_id AND u.person_id=a.person_id AND u.status='ACTIVE'
       AND EXISTS(SELECT 1 FROM jsonb_array_elements(part->'accounts') q WHERE q->>'id'=u.id::text))))
   THEN RAISE EXCEPTION 'whole configuration Review requires the actual complete active Team graph'; END IF;
   team_ids:=team_ids||jsonb_build_array(pin->>'id');
  END LOOP;
  FOREACH family IN ARRAY ARRAY['people','accounts','roles'] LOOP
   FOR pin IN SELECT * FROM jsonb_array_elements(part->family) LOOP
    PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,CASE family WHEN 'people' THEN 'person' WHEN 'accounts' THEN 'user_account' ELSE 'role' END,pin);
    IF pin-(CASE family WHEN 'people' THEN ARRAY['id','rowVersion','tuple'] WHEN 'accounts' THEN ARRAY['id','rowVersion','tuple','personId'] ELSE ARRAY['id','rowVersion','tuple','permissionsHash','permissionCount'] END)<>'{}'::jsonb
    THEN RAISE EXCEPTION 'whole configuration Review Team source pins must contain identities only'; END IF;
    IF family='roles' THEN
     review_review_role_id:=(pin->>'id')::uuid;
     SELECT coalesce(md5(string_agg(rp.permission_id::text||':'||rp.xmin::text||':'||rp.ctid::text||':'||coalesce(p.key,'MISSING')||':'||coalesce(p.resource,'MISSING')||':'||coalesce(p.action,'MISSING')||':'||coalesce(p.xmin::text,'MISSING')||':'||coalesce(p.ctid::text,'MISSING'),'|' ORDER BY rp.permission_id)),md5('')),count(*)::int
      INTO signature,permission_count FROM role_permission rp LEFT JOIN permission p ON p.organization_id=rp.organization_id AND p.id=rp.permission_id WHERE rp.organization_id=NEW.organization_id AND rp.role_id=review_role_id;
     IF signature IS DISTINCT FROM pin->>'permissionsHash' OR permission_count IS DISTINCT FROM(pin->>'permissionCount')::int
     THEN RAISE EXCEPTION 'whole configuration Review role permission sources changed'; END IF;
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 SELECT coalesce(jsonb_agg(a.id::text ORDER BY a.id),'[]'::jsonb) INTO actual_ids FROM role_assignment a WHERE a.organization_id=NEW.organization_id AND a.scope_type='property' AND a.scope_id=NEW.property_id AND a.archived_at IS NULL;
 IF actual_ids IS DISTINCT FROM(SELECT coalesce(jsonb_agg(v ORDER BY v),'[]'::jsonb) FROM jsonb_array_elements_text(team_ids) v)
 THEN RAISE EXCEPTION 'whole configuration Review must retain every actual current Team assignment without a command-batch truncation'; END IF;
 minimum_count:=(policy.value#>>'{team,minimum_assignments}')::numeric;
 IF minimum_count IS NULL OR minimum_count<0 OR minimum_count<>trunc(minimum_count) OR jsonb_array_length(team_ids)<minimum_count
 THEN RAISE EXCEPTION 'whole configuration Review requires its configured actual Team minimum'; END IF;
 channel_ids:='[]'::jsonb;
 FOR pin IN SELECT * FROM jsonb_array_elements(source#>'{bookingChannels,pins}') LOOP
  PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'booking_channel',pin);
  IF pin-ARRAY['id','propertyId','archivedAt','rowVersion','tuple']<>'{}'::jsonb OR pin->>'propertyId' IS DISTINCT FROM NEW.property_id::text
   OR NOT EXISTS(SELECT 1 FROM booking_channel c WHERE c.organization_id=NEW.organization_id AND c.id=(pin->>'id')::uuid AND c.property_id=NEW.property_id AND c.archived_at IS NULL)
  THEN RAISE EXCEPTION 'whole configuration Review requires actual current original-Property Booking Channels'; END IF;
  channel_ids:=channel_ids||jsonb_build_array(pin->>'id');
 END LOOP;
 SELECT coalesce(jsonb_agg(c.id::text ORDER BY c.id),'[]'::jsonb) INTO actual_ids FROM booking_channel c WHERE c.organization_id=NEW.organization_id AND c.property_id=NEW.property_id AND c.archived_at IS NULL;
 IF actual_ids IS DISTINCT FROM(SELECT coalesce(jsonb_agg(v ORDER BY v),'[]'::jsonb) FROM jsonb_array_elements_text(channel_ids) v)
 THEN RAISE EXCEPTION 'whole configuration Review must retain every actual current Booking Channel'; END IF;
 minimum_count:=(policy.value#>>'{booking_channels,minimum_channels}')::numeric;
 IF minimum_count IS NULL OR minimum_count<0 OR minimum_count<>trunc(minimum_count) OR jsonb_array_length(channel_ids)<minimum_count
 THEN RAISE EXCEPTION 'whole configuration Review requires its configured Booking Channel minimum'; END IF;
 FOREACH family IN ARRAY ARRAY['inventory','services','workflows'] LOOP
  part:=source->family;
  IF part-(CASE family WHEN 'workflows' THEN ARRAY['rules','binding','templates','scopes','fingerprint'] ELSE ARRAY['rule','binding','templates','scopes','fingerprint'] END)<>'{}'::jsonb
   OR NOT coalesce(part->>'fingerprint' ~ '^[a-f0-9]{64}$',false)
  THEN RAISE EXCEPTION 'whole configuration Review catalog source manifest contains unregistered values'; END IF;
  SELECT * INTO binding FROM property_template_revision r WHERE r.organization_id=NEW.organization_id AND r.property_id=NEW.property_id
   AND r.kind=CASE family WHEN 'inventory' THEN 'INVENTORY' WHEN 'services' THEN 'SERVICE_CATALOG' ELSE 'WORKFLOW' END ORDER BY r.revision DESC LIMIT 1;
  pin:=part->'binding';
  IF binding.id IS DISTINCT FROM(pin->>'id')::uuid OR(family='workflows' AND binding.id IS NULL)
  THEN RAISE EXCEPTION 'whole configuration Review requires the actual latest canonical template binding'; END IF;
  IF binding.id IS NOT NULL THEN
   PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'property_template_revision',pin);
   IF pin-ARRAY['id','revision','templateVersionId','createdBy','createdAt','rowVersion','tuple']<>'{}'::jsonb
    OR binding.revision IS DISTINCT FROM(pin->>'revision')::int OR binding.template_version_id IS DISTINCT FROM(pin->>'templateVersionId')::uuid
    OR jsonb_array_length(part->'templates')<>1
   THEN RAISE EXCEPTION 'whole configuration Review binding source does not match its complete actual template'; END IF;
  ELSIF jsonb_array_length(part->'templates')<>0 THEN RAISE EXCEPTION 'whole configuration Review cannot add an unbound private template'; END IF;
  FOR pin IN SELECT * FROM jsonb_array_elements(part->'templates') LOOP
   PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'property_template_version',pin);
   SELECT * INTO template FROM property_template_version WHERE organization_id=NEW.organization_id AND id=(pin->>'id')::uuid;
   IF pin-ARRAY['id','key','version','propertyId','status','createdBy','createdAt','rowVersion','tuple','latestId','latestStatus']<>'{}'::jsonb
    OR template.id IS DISTINCT FROM binding.template_version_id OR template.created_by IS NULL OR template.status<>'ACTIVE'
    OR template.kind<>(CASE family WHEN 'inventory' THEN 'INVENTORY' WHEN 'services' THEN 'SERVICE_CATALOG' ELSE 'WORKFLOW' END)
    OR(template.property_id IS NOT NULL AND template.property_id<>NEW.property_id)
    OR 'ACTIVE' IS DISTINCT FROM(SELECT status FROM property_template_version WHERE organization_id=NEW.organization_id AND key=template.key ORDER BY version DESC LIMIT 1)
   THEN RAISE EXCEPTION 'whole configuration Review requires its actual attributable active standard source template'; END IF;
  END LOOP;
 END LOOP;
 FOREACH key_name IN ARRAY ARRAY['inventory.minimums','services.pricing','ops.workflows','ops.reservation_task_templates','ops.checklists','ops.mid_stay_threshold'] LOOP
  IF key_name='ops.mid_stay_threshold' THEN
   IF NOT EXISTS(SELECT 1 FROM property_operating_profile p WHERE p.organization_id=NEW.organization_id AND p.property_id=NEW.property_id AND p.mid_stay_cleaning_enabled) THEN
    IF source->'operatingRule' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'whole configuration Review cannot invent a disabled mid-stay source'; END IF;
    CONTINUE;
   END IF;
   pin:=source->'operatingRule';
  ELSIF key_name='inventory.minimums' THEN pin:=source#>'{inventory,rule}';
  ELSIF key_name='services.pricing' THEN pin:=source#>'{services,rule}';
  ELSE SELECT r->'row' INTO pin FROM jsonb_array_elements(source#>'{workflows,rules}') r WHERE r->>'key'=key_name;
  END IF;
  -- Match the existing canonical latest-per-scope retirement and precedence selector.
  WITH applicable AS(SELECT c.*,CASE c.scope_type WHEN 'agreement' THEN 5 WHEN 'property' THEN 4 WHEN 'owner' THEN 3 WHEN 'city' THEN 2 ELSE 1 END AS rank
   FROM config_rule c WHERE c.organization_id=NEW.organization_id AND c.key=key_name AND c.archived_at IS NULL AND c.lifecycle IN('ACTIVE','RETIRED')
    AND c.effective_from<=NEW.created_at AND(c.effective_to IS NULL OR c.effective_to>NEW.created_at)
    AND((c.scope_type='organization' AND c.scope_id IS NULL) OR(c.scope_type='city' AND c.scope_id=physical.city_id)
     OR(c.scope_type='owner' AND c.scope_id=NEW.owner_id) OR(c.scope_type='property' AND c.scope_id=NEW.property_id)
     OR(c.scope_type='agreement' AND c.scope_id=(SELECT id FROM management_agreement WHERE organization_id=NEW.organization_id AND property_id=NEW.property_id AND archived_at IS NULL AND status<>'DRAFT' AND effective_from<=NEW.created_at AND(effective_to IS NULL OR effective_to>NEW.created_at) ORDER BY effective_from DESC,id DESC LIMIT 1)))),
   latest_per_scope AS(SELECT DISTINCT ON(scope_type,scope_id) * FROM applicable ORDER BY scope_type,scope_id,effective_from DESC,version DESC)
  SELECT id INTO selected FROM latest_per_scope WHERE lifecycle='ACTIVE' ORDER BY rank DESC,effective_from DESC,version DESC LIMIT 1;
  IF selected IS DISTINCT FROM(pin->>'id')::uuid OR(selected IS NULL AND key_name IN('inventory.minimums','services.pricing','ops.mid_stay_threshold'))
  THEN RAISE EXCEPTION 'whole configuration Review must retain actual effective canonical source rules'; END IF;
  IF selected IS NOT NULL THEN
   PERFORM app_assert_onboarding_configuration_pin(NEW.organization_id,'config_rule',jsonb_build_object('id',pin->>'id','rowVersion',pin->>'xmin','tuple',pin->>'tuple'));
   SELECT * INTO configuration FROM config_rule WHERE organization_id=NEW.organization_id AND id=selected;
   IF pin-ARRAY['id','key','version','scopeType','scopeId','lifecycle','createdBy','createdAt','effectiveFrom','effectiveTo','archivedAt','xmin','tuple']<>'{}'::jsonb
    OR configuration.created_by IS NULL OR configuration.key<>key_name OR configuration.version IS DISTINCT FROM(pin->>'version')::int
   THEN RAISE EXCEPTION 'whole configuration Review requires attributable actual source metadata without private values'; END IF;
   CASE key_name
    WHEN 'inventory.minimums' THEN actual_count:=jsonb_array_length(configuration.value->'minimums');minimum_count:=(policy.value#>>'{inventory,minimum_items}')::numeric;
    WHEN 'services.pricing' THEN actual_count:=jsonb_array_length(configuration.value->'services');minimum_count:=(policy.value#>>'{services,minimum_services}')::numeric;
    WHEN 'ops.workflows' THEN actual_count:=jsonb_array_length(configuration.value->'workflows');minimum_count:=(policy.value#>>'{workflows,minimum_workflows}')::numeric;
    WHEN 'ops.reservation_task_templates' THEN actual_count:=jsonb_array_length(configuration.value->'tasks');minimum_count:=(policy.value#>>'{workflows,minimum_tasks}')::numeric;
    ELSE actual_count:=0;minimum_count:=0;
   END CASE;
   IF minimum_count IS NULL OR minimum_count<0 OR minimum_count<>trunc(minimum_count) OR actual_count IS NULL OR actual_count<minimum_count
   THEN RAISE EXCEPTION 'whole configuration Review requires its configured actual source minimums'; END IF;
  ELSIF key_name='ops.workflows' AND coalesce((policy.value#>>'{workflows,minimum_workflows}')::numeric,1)>0
     OR key_name='ops.reservation_task_templates' AND coalesce((policy.value#>>'{workflows,minimum_tasks}')::numeric,1)>0
  THEN RAISE EXCEPTION 'whole configuration Review cannot omit a configured required operational source'; END IF;
 END LOOP;
 RETURN NEW;
END $$;

CREATE TRIGGER property_onboarding_configuration_guard BEFORE INSERT ON property_onboarding_revision
 FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_configuration_revision();

COMMIT;
