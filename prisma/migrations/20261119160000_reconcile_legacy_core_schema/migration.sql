BEGIN;

-- Some databases applied the first Owners and Properties migration before its
-- Prisma alignment. Preserve the original migration and normalize the live DDL.
DO $$
DECLARE
  existing_index record;
BEGIN
  SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate,
         pg_get_indexdef(i.indexrelid, 1, true) AS first_key,
         pg_get_indexdef(i.indexrelid, 2, true) AS second_key,
         i.indisunique AS is_unique,
         i.indisvalid AS is_valid,
         i.indnatts AS attribute_count
    INTO existing_index
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('public.owner_org_email_unique')
     AND i.indrelid = 'public.owner'::regclass;

  IF NOT FOUND
     OR NOT existing_index.is_unique
     OR NOT existing_index.is_valid
     OR existing_index.attribute_count <> 2
     OR existing_index.first_key IS DISTINCT FROM 'organization_id'
     OR existing_index.second_key IS DISTINCT FROM 'email' THEN
    RAISE EXCEPTION 'Unexpected owner email uniqueness definition';
  END IF;

  IF existing_index.predicate IS NOT NULL THEN
    IF existing_index.predicate <> '(email IS NOT NULL)' THEN
      RAISE EXCEPTION 'Unexpected legacy owner email index predicate';
    END IF;

    LOCK TABLE public.owner IN ACCESS EXCLUSIVE MODE;
    ALTER INDEX public.owner_org_email_unique RENAME TO owner_org_email_legacy_idx;
    ALTER TABLE public.owner ADD CONSTRAINT owner_org_email_unique UNIQUE (organization_id, email);
    DROP INDEX public.owner_org_email_legacy_idx;
  END IF;
END $$;

ALTER TABLE public.property
  ALTER COLUMN amenities DROP DEFAULT,
  ALTER COLUMN photo_urls DROP DEFAULT;

COMMIT;
