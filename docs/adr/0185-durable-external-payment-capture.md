# 0185 — Durable optional external payment capture

An external capture can succeed while its acknowledgement is lost or the requesting actor's grants change. Retain an immutable tenant/actor/order/Money intent and transactional outbox reference before provider I/O. Retain a separately audited attempt marker before contacting the provider. Provider requests run outside tenant financial transactions.

Reconcile an uncertain prior attempt with an authenticated order GET before another capture POST. A completed original capture may be retained after grant revocation; a new POST must pass the original held restrictions and current source/funding authority. Native unique source identities prevent another tenant or command from claiming the same order or capture.

Retain the provider's capture creation time separately from local observation time. Financial receipt dates use the retained provider time, preserving the original accounting period during delayed reconciliation. Retain actual gross, deductions and merchant net with exact Money conservation. Missing or inconsistent settlement evidence does not imply zero deductions.

The configured method names its merchant ledger location. A verified PayPal capture does not establish that money reached a company bank or staff wallet. Financial admission uses the original receipt producer, frozen booking provenance and retained method version. Disabling or remapping future captures must not rewrite the original source or prevent admission of already-confirmed funds under its retained method. All original current authority checks and append-only native guards remain.

The existing bounded finance consumer handles capture and failed-outcome references. An exhausted execution remains unconfirmed and reconcilable; it is never evidence that no money moved. Private presentation must authorize the actual retained financial source independently of audit labels or operational access.

Provider documentation: [order capture and source fields](https://developer.paypal.com/sdk/orders/v2/definitions/capture/), [gross, deductions and net](https://developer.paypal.com/serversdk/java/models/structures/seller-receivable-breakdown), and [request identity and uncertain responses](https://developer.paypal.com/api/rest/reference/idempotency/). No capture response body, OAuth token or payer personal information is written to application diagnostics.
