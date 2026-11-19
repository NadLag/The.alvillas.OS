CREATE TABLE public_website_daily_metric (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  day date NOT NULL,
  locale char(2) NOT NULL CHECK (locale IN ('en', 'fr', 'ar')),
  page_path text NOT NULL CHECK (page_path IN ('', '/management', '/services', '/about', '/assessment')),
  page_views bigint NOT NULL CHECK (page_views > 0),
  PRIMARY KEY (organization_id, day, locale, page_path)
);

ALTER TABLE public_website_daily_metric ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_website_daily_metric FORCE ROW LEVEL SECURITY;
CREATE POLICY public_website_daily_metric_tenant_isolation ON public_website_daily_metric
  USING (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);
