# 0051 — Field app installation, updates and background acknowledgements

The field app uses the existing root-scoped service worker for installation and background work. The worker now bundles the shared Dexie store and sync transport, preserving the authenticated notification handlers. Browser-only validation and legacy localStorage migration stay in the foreground facade; the worker reads already stored operations and uses the same server protocol. This keeps the worker bundle near 107 KB instead of including the foreground validation bundle.

The worker is served through a public JavaScript route with the release version embedded in its response. Updates wait for an explicit refresh. Unsaved form changes defer that refresh, and refresh is unavailable offline. Acknowledged completions notify the active task page whether the acknowledgement arrives in the foreground or worker. Repeated foreground requests coalesce, while cross-tab/worker retries retain server idempotency and ownership checks.

CacheStorage contains only same-origin Next.js static assets. Authenticated pages, API responses and operational records remain outside it. The current and previous public-asset cache generations are retained. IndexedDB remains the only local operation store and is cleared through the established logout/revocation path.

Foreground/focus sync remains available when a browser disables Background Sync. Native background acceptance uses full Chromium with a normal temporary profile, registers a real sync tag, closes the task page, dispatches native sync events and verifies one PostgreSQL completion audit/outbox event. The default headless shell returns a disabled-service error for this API. Temporary profiles are removed only after verifying their resolved parent and generated name.

The day's offline job cache and cursor pull remain separate unfinished requirements. Installation does not change server permissions or allow actions without an authenticated session.
