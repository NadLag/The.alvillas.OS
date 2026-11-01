# Bounded assignment scope search at portfolio size

The 500-property Finance acceptance adds real properties in both browser projects. The existing staff form loaded a silent maximum of 1,000 property choices. A later real property could not be selected, and retained assignment labels could fall back to identifiers. Increasing that limit would retain the same failure at a larger portfolio.

Scope selection now searches the actual property, city or region source in bounded pages. The existing team server-action session is reused. Each search requires held and current role-assignment authority; returned labels also require access to the corresponding source and pass the existing field serializer. The final stored-authority check follows the attributed read audit, so denied or revoked access rolls the read back. Foreign and wrong-kind cursors are rejected. No new authentication provider or storage is introduced.

The form retains the role, dates, account and reason while scope choices are searched or paged. Scope changes, new searches, connection loss and denied access clear the selected target and old results. Only 25 records are displayed at once. Existing assignments load their labels by their actual retained identifiers, independently of the picker page.

The same portfolio acceptance exposed repeated identical authorization resources during percentage source compilation. Exact duplicate checks within one boundary are coalesced before the existing held/current checker. Each distinct journal, source scope, amount and occurrence remains checked; source preparation still runs again after durable admission. The typed witnesses, source fingerprint, SQL admission guards and 2,000 ms HTTP p95 requirement remain unchanged. No applied migration is edited.
