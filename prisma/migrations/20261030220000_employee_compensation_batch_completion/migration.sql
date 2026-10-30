BEGIN;

-- The deferred header check validates the complete batch once. Each child is
-- independently bound to that immutable header, admitted only in its birth
-- transaction, and unique for its actual beneficiary/completion source.
-- Once the header is complete, those same constraints prevent a later child.
DROP TRIGGER employee_submission_complete ON employee_compensation_cost;
DROP TRIGGER employee_submission_complete ON employee_compensation_claim;

COMMIT;
