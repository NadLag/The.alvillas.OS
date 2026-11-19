# Public website boundaries

F-WEB-01 to F-WEB-08 serve the marketing pages from a public root layout. The private app keeps its existing session and message provider. The locked specification supplies the public canonical origin. Public page and social images have explicit dimensions, and the homepage renders its existing brand mark and decorative artwork without fetching a villa image.

The assessment reuses the website CRM capture policy, encrypted original, quota, outbox and audit. The effective policy must provide the approved notice in EN, FR and AR and its canonical JSONB SHA-256. A short-lived proof binds the transaction nonce to that policy version and tenant. Legacy API callers that use a policy without a form keep their existing contract.

First-party page views are disabled until `ALVILLAS_PUBLIC_ANALYTICS` and an effective `website.analytics` policy are enabled for the bound organization. The application records only daily counts by supported route and language. The organization report permission gates reading; privacy signals suppress collection. The server never retains network, account, referrer or device identifiers in these metrics.

Use Lighthouse mobile navigation reports for the staging public routes with `npm run check:public-performance -- <reports>`. The check enforces the handbook score, LCP and CLS gates. Verify INP during the hosted interaction acceptance.
