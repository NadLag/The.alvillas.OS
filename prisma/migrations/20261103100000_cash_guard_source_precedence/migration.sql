BEGIN;

-- Preserve the native source-acknowledgement guard before the shared cash budget
-- guard. Both remain deferred and mandatory; malformed service journals must
-- still fail their original, independently tested admission boundary.
ALTER TRIGGER original_cash_source_budget ON posting
 RENAME TO zz_original_cash_source_budget;

COMMIT;
