# 0069 — Verify idle updates and active background work separately

The retained 161/162 server-projection run shows eleven activation messages sent
to the same installed replacement, with the original controller still active.
The earlier diagnostic observed only page requests, so it cannot establish that
the active worker had no outstanding work. Retransmitting one message alone does
not explain every observed timeout.

Keep the existing three-second application deadline and safe failure behavior.
The idle queued-work journey now explicitly dispatches and awaits a native
background attempt, confirms its queued transport outcome, and retains every
original reload, checklist, draft, queue, cache and single-execution assertion.
Failure diagnostics track individual context requests, including worker requests,
and collect bounded worker-runtime/error observations.

A separate desktop/mobile journey holds a real native background acknowledgement
after PostgreSQL commits the original completion. While that request is active,
explicit update must preserve the current document and original queued operation
and offer retry. After the acknowledgement is released, the native worker must
clear the queue, and explicit user retry must adopt the replacement and reload.
The original completion audit and outbox event must each remain exactly one.
The existing closed-page background completion journey also remains unchanged.

Both journeys use the real browser lifecycle, application API and PostgreSQL.
An opt-in localhost HTTP fixture returns transport failures or holds the actual
application response after commit; browser request routing does not participate
in worker replacement. Strict local database and storage guards keep this
preload out of deployments, and staging verification checks its endpoint is absent.
The gate uses a localhost-only cookie; it adds no global request header and
therefore does not alter unrelated cross-origin requests. The retained 163/164
run still failed one held-work retry after all original update journeys passed.
Additional observers count actual worker messages/native activation calls and
record lifecycle/request state without issuing extra activation requests.
Chromium's `ServiceWorkerHandler::DispatchSyncEvent` returns success after it
requests dispatch; its eventual completion callback is deliberately ignored.
The held-work test therefore observes the actual promise passed to the native
`waitUntil`, preserving that same promise and native call, and requires every
observed background lifetime to settle before explicit retry. An acknowledged
protocol command and an empty device queue alone do not establish this premise.
Native idle termination after acknowledgement can discard that observed runtime
before another request restarts the same active version; the test retains the
original version's stopped notification as that lifetime boundary.
Source: [Chromium dispatch implementation](https://chromium.googlesource.com/chromium/src/+/cc5c4286cb619bf0534f3e302f4ae571409a3459/content/browser/devtools/protocol/service_worker_handler.cc).

Simulate a deployment by changing script bytes at the existing `/sw.js` URL.
The previous query-string replacement differed from the application's subsequent
registration of `/sw.js`. The fixture appends only a release comment to the real
worker and defers HTTP headers until the revised body is complete. A native HTTP
check verifies revised bytes and untouched unscoped responses. Before unloading,
the held-acknowledgement journey records whether the actual waiting worker object
became the controller, rather than inferring adoption from a changed URL.
The manually created browser contexts explicitly retain the suite's 30-second
action/navigation limits. Failure diagnostics are bounded and read-only.

The controlled held-acknowledgement case reproduces the installed-waiting state
and verifies the intended safe retry contract. It does not prove that every
earlier timeout had the same cause.

The native trace records both real Sync requests completing, followed by a
workspace server action and `/api/sync/pull` at the exact point the exiting worker
stops. Those requests restart that active version while promotion is pending.
The push hook treated every worker message as a subscription change; the field
consumer also started another drain/pull for acknowledgements and unrelated
messages, even though the native acknowledgement already updated IndexedDB.

Each consumer now accepts its own existing protocol. Push reconciliation still
runs on actual subscription changes, permissions, online, focus and visibility.
Field acknowledgements update navigation without starting another drain; a
finished background attempt defers its redundant pull while a replacement waits.
Manual and focus synchronization remain available. The push hook regression
fails before the filter and passes afterward, including permission/focus updates
and listener cleanup. The held-work test preserves its original assertions.

The speculative workspace-prefetch and activation-message-lifetime experiments
were reverted after the complete suite still passed only 163/164. The worker
activation handler, application deadline and browser security settings retain
their original behavior. This trace does not establish the cause of every
earlier timeout; no reload, queue, attribution or single-execution assertion is
removed or weakened.
