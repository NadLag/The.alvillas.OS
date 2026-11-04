BEGIN;

CREATE FUNCTION app_guest_accommodation_native_target_snapshot(org uuid,booking_id uuid,gross numeric,
 currency_code text,guest_account uuid,owner_account uuid,company_account uuid) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH confirmation AS(
  SELECT r.after FROM reservation_revision r WHERE r.organization_id=org AND r.reservation_id=booking_id
   AND r.operation='CONFIRM' ORDER BY r.version ASC LIMIT 1
 ), vector AS(
  SELECT guest_account AS account_id,'OWNER_REVENUE'::text AS bucket,gross AS debit,
   jsonb_build_object('source',c.after->>'source','reservation_id',booking_id::text,
    'reservation_reference',c.after->>'reference','property_id',c.after->>'propertyId',
    'posting_kind','accommodation_revenue_received') AS dimensions FROM confirmation c WHERE gross>0
  UNION ALL SELECT t.account_id,t.bucket,t.debit,t.dimensions
   FROM app_guest_accommodation_owner_target(org,booking_id,gross,owner_account,company_account) t
 ), objects AS(
  SELECT jsonb_build_object('ledgerAccountId',v.account_id::text,'side',CASE WHEN v.debit>0 THEN 'DEBIT' ELSE 'CREDIT' END,
   'amount',abs(v.debit)::numeric(18,2)::text,'currency',currency_code,'bucket',v.bucket,'dimensions',v.dimensions) AS value FROM vector v
 ) SELECT coalesce(jsonb_agg(o.value ORDER BY o.value::text),'[]'::jsonb) FROM objects o;
$$;

CREATE FUNCTION app_guard_guest_application_retained_target() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 saved jsonb; owners jsonb; expected jsonb; actual jsonb; field_name text; gross numeric;
BEGIN
 SELECT a.after INTO saved FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_type='financial_transaction'
  AND a.resource_id=NEW.transaction_id AND a.action='finance.guest_deposit.applied';
 -- Missing command evidence is rejected by the original application source guard.
 IF saved IS NULL THEN RETURN NEW; END IF;
 SELECT jsonb_agg(x.value->'ownerId' ORDER BY x.ordinality) INTO owners FROM(
  SELECT s.rules->'owners' AS roster FROM reservation_financial_snapshot s WHERE s.organization_id=NEW.organization_id
   AND s.reservation_id=(saved->'source'->>'reservationId')::uuid AND jsonb_typeof(s.rules->'owners')='array'
  ORDER BY s.version ASC LIMIT 1
 ) r CROSS JOIN LATERAL jsonb_array_elements(r.roster) WITH ORDINALITY x;
 IF owners IS NULL OR owners IS DISTINCT FROM saved->'originalOwnerOrder' THEN RAISE EXCEPTION 'guest_application_retained_original_owner_order_required'; END IF;
 FOREACH field_name IN ARRAY ARRAY['nativeBefore','nativeAfter'] LOOP
  gross:=(saved->>CASE field_name WHEN 'nativeBefore' THEN 'appliedBefore' ELSE 'appliedAfter' END)::numeric;
  expected:=app_guest_accommodation_native_target_snapshot(NEW.organization_id,(saved->'source'->>'reservationId')::uuid,gross,
   saved->'input'->>'currency',(saved->>'liabilityAccountId')::uuid,(saved->>'ownerPayableAccountId')::uuid,(saved->>'commissionRevenueAccountId')::uuid);
  SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO actual FROM jsonb_array_elements(saved->field_name) x;
  IF saved->field_name IS NULL OR actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'guest_application_retained_native_target_snapshot_required'; END IF;
 END LOOP;
 RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER guest_funded_application_snapshot_guard AFTER INSERT ON posting
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.dimensions->>'deposit_operation'='APPLICATION') EXECUTE FUNCTION app_guard_guest_application_retained_target();

COMMIT;
