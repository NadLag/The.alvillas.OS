-- Select the original first leg chronologically; its full-precision PostgreSQL
-- timestamp and group identity retain stable cursors without JSON date rounding.
CREATE INDEX inventory_movement_recorded_history_idx ON inventory_movement(organization_id,created_at,movement_group_id);
