BEGIN;
-- Preserve the complete existing expression and extend only the approved kind.
DO $$
DECLARE previous_expression text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO previous_expression FROM pg_constraint
    WHERE conrelid='notification'::regclass AND conname='notification_kind_check' AND contype='c';
  IF previous_expression IS NULL THEN RAISE EXCEPTION 'original notification kind guard is required'; END IF;
  ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
  EXECUTE format('ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK ((%s) OR kind=%L)',previous_expression,'lead_reminder');
END
$$;
COMMIT;
