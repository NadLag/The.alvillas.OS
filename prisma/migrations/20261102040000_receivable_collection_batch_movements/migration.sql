BEGIN;
CREATE FUNCTION public.app_receivable_collection_movements_for(org_uuid uuid,assignment_uuids uuid[],currency_code text,except_collection uuid DEFAULT NULL)
 RETURNS TABLE(assignment_id uuid,collected numeric,fingerprint text) LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 WITH requested AS MATERIALIZED(
  SELECT DISTINCT value AS assignment_id FROM unnest(assignment_uuids) AS requested_id(value)
 ),sources AS MATERIALIZED(
  SELECT requested.assignment_id,c.id,c.transaction_id,p.ledger_account_id FROM requested
  JOIN receivable_collection c ON c.organization_id=org_uuid AND c.assignment_id=requested.assignment_id
  JOIN receivable_assignment a ON a.organization_id=c.organization_id AND a.id=c.assignment_id
  JOIN posting p ON p.organization_id=a.organization_id AND p.id=a.posting_id
  WHERE except_collection IS NULL OR c.id<>except_collection
 ),journals AS MATERIALIZED(
  SELECT s.assignment_id,s.id collection_id,s.ledger_account_id,t.id,t.reverses_transaction_id,t.occurred_at FROM sources s
  JOIN financial_transaction t ON t.organization_id=org_uuid AND t.id=s.transaction_id
  UNION ALL
  SELECT s.assignment_id,s.id,s.ledger_account_id,t.id,t.reverses_transaction_id,t.occurred_at FROM sources s
  JOIN financial_transaction t ON t.organization_id=org_uuid AND t.reverses_transaction_id=s.transaction_id
 ),movements AS MATERIALIZED(
  SELECT j.assignment_id,j.collection_id,j.id journal_id,j.reverses_transaction_id,j.occurred_at,
   p.id posting_id,p.ledger_account_id,p.side,p.amount,p.currency
  FROM journals j JOIN posting p ON p.organization_id=org_uuid AND p.transaction_id=j.id
   AND p.ledger_account_id=j.ledger_account_id AND p.currency=currency_code
 )
 SELECT requested.assignment_id,COALESCE(sum(CASE WHEN m.side='CREDIT' THEN m.amount ELSE -m.amount END),0),
  encode(sha256(convert_to(COALESCE(string_agg(concat_ws(':',m.collection_id,m.journal_id,m.posting_id,m.side,m.amount::text,m.currency,m.reverses_transaction_id,m.ledger_account_id,
   to_char(m.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),',' ORDER BY m.journal_id,m.posting_id) FILTER(WHERE m.posting_id IS NOT NULL),''),'UTF8')),'hex')
 FROM requested LEFT JOIN movements m ON m.assignment_id=requested.assignment_id GROUP BY requested.assignment_id;
$$;

-- Keep the original scalar boundary, exact fingerprints and all existing callers.
CREATE OR REPLACE FUNCTION public.app_receivable_collection_movements(org_uuid uuid,assignment_uuid uuid,currency_code text,except_collection uuid DEFAULT NULL)
 RETURNS TABLE(collected numeric,fingerprint text) LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $$
 SELECT m.collected,m.fingerprint FROM app_receivable_collection_movements_for(org_uuid,ARRAY[assignment_uuid],currency_code,except_collection) m;
$$;
COMMIT;
