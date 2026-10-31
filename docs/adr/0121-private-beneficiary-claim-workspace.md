# ADR 0121: Review original beneficiary claims through private, source-bound reads

Status: Accepted for integration; complete F-FIN-24 and staging acceptance remain outstanding.

The cost proposal links to a beneficiary list and a separate earned-claim review. The list reports each original beneficiary's complete amount and work count. Claim detail pages retain that complete amount while paging the beneficiary's original work, allocation and completion evidence. They show actual immutable recognition links, source dates, posting dates and the current actor's request history. Recognition records the earned liability; the interface makes no payment claim.

The canonical submission reader still authorizes the complete original artifact before selecting a beneficiary or work page. A claim additionally requires the actual expense sources and any linked journals. Labels retain the existing independent identity, property and task checks. Source facts, receipt state and positive disclosure checks are checked again before returning the response. An available recognition action also rechecks its actual current posting authority. A pending request belonging to another actor exposes only the pending state; its request ID, reason, input and retained restrictions remain private.

Beneficiary and work cursors must belong to the actual source. Request history cursors must belong to the actual beneficiary and current actor. History orders by the original request timestamp and ID, using the database cursor so PostgreSQL timestamp precision remains intact. The complete amount never changes to a page subtotal.

Financial data is loaded through private, uncached authenticated APIs and retained only in browser memory. Server-rendered page props contain route IDs and the existing scoped recovery identifier. Connection loss or denied access clears financial facts and form intent. The existing cost-proposal command and recognition command share one recovery hook: only a scoped random nonce survives a reload. An uncertain acknowledgement retains the exact in-memory command for an exact retry; a terminal outcome requires an explicit new request. Worker replay remains the existing durable source of truth.

A closed original period requires the user's explicit current-period adjustment choice. The checkbox starts unchecked; the original cost date remains visible in the resulting recognition. The authoritative command independently checks the original source, permissions and accounting period. No amount, beneficiary, allocation or original work date can be edited through the recognition form.

The screens reuse the existing design system, private read hook, source-label policy, money formatting and work-evidence component in English, French and Arabic. This change adds no business table or migration and does not alter existing migration bytes. Employee payments, wallet offsets, other earning modes, corrections and authenticated staging remain required feature work.
