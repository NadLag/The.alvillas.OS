CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX command_search_property_fts ON property USING gin (to_tsvector('simple'::regconfig,name)) WHERE archived_at IS NULL;
CREATE INDEX command_search_property_trgm ON property USING gin (name gin_trgm_ops) WHERE archived_at IS NULL;
CREATE INDEX command_search_reservation_fts ON reservation USING gin (to_tsvector('simple'::regconfig,reference)) WHERE archived_at IS NULL;
CREATE INDEX command_search_reservation_trgm ON reservation USING gin (reference gin_trgm_ops) WHERE archived_at IS NULL;
CREATE INDEX command_search_task_fts ON operation_task USING gin (to_tsvector('simple'::regconfig,
  coalesce(title_translations->>'en','') || ' ' || coalesce(title_translations->>'fr','') || ' ' || coalesce(title_translations->>'ar',''))) WHERE archived_at IS NULL;
CREATE INDEX command_search_task_trgm ON operation_task USING gin ((
  coalesce(title_translations->>'en','') || ' ' || coalesce(title_translations->>'fr','') || ' ' || coalesce(title_translations->>'ar','')) gin_trgm_ops) WHERE archived_at IS NULL;
CREATE INDEX command_search_issue_fts ON operation_issue USING gin (to_tsvector('simple'::regconfig,title));
CREATE INDEX command_search_issue_trgm ON operation_issue USING gin (title gin_trgm_ops) WHERE title IS NOT NULL;
CREATE INDEX command_search_asset_tag_trgm ON asset USING gin (tag gin_trgm_ops) WHERE tag IS NOT NULL;
CREATE INDEX command_search_asset_name_fts ON asset_revision USING gin (to_tsvector('simple'::regconfig,name));
CREATE INDEX command_search_asset_name_trgm ON asset_revision USING gin (name gin_trgm_ops) WHERE name IS NOT NULL;
CREATE INDEX command_search_owner_fts ON owner USING gin (to_tsvector('simple'::regconfig,display_name)) WHERE archived_at IS NULL;
CREATE INDEX command_search_owner_trgm ON owner USING gin (display_name gin_trgm_ops) WHERE archived_at IS NULL;
CREATE INDEX command_search_supplier_fts ON supplier USING gin (to_tsvector('simple'::regconfig,display_name)) WHERE archived_at IS NULL;
CREATE INDEX command_search_supplier_trgm ON supplier USING gin (display_name gin_trgm_ops) WHERE archived_at IS NULL;
