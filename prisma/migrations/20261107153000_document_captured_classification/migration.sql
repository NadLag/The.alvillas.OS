-- New roots must identify the exact immutable tenant rule used for their
-- classification. Existing captured history and financial data are untouched.
CREATE FUNCTION app_guard_document_captured_classification() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rule config_rule%ROWTYPE; type_policy jsonb;
BEGIN
  SELECT * INTO rule FROM config_rule WHERE organization_id=NEW.organization_id
    AND id=(NEW.policy_snapshot->>'id')::uuid;
  IF rule.id IS NULL OR rule.key<>'documents.archive'
    OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object('id',rule.id,'version',rule.version,'value',rule.value)
  THEN RAISE EXCEPTION 'document original classification requires its exact tenant rule'; END IF;
  SELECT value INTO type_policy FROM jsonb_array_elements(rule.value->'types') WHERE value->>'key'=NEW.type_key;
  IF type_policy IS NULL OR NOT coalesce(type_policy->'sources' ? NEW.source_kind,false)
    OR NOT NEW.privacy@>ARRAY(SELECT jsonb_array_elements_text(type_policy->'privacy'))
    OR NOT app_document_category_protected(NEW.policy_snapshot,NEW.type_key,NEW.privacy)
  THEN RAISE EXCEPTION 'document original classification requires its exact tenant rule'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_captured_classification_guard AFTER INSERT ON document
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_guard_document_captured_classification();
