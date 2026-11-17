# ADR 0271: Author the existing physical inventory locations

Status: Accepted

F-INV-02 extends InventoryLocation, retaining its existing PROPERTY, STORE,
LAUNDRY and IN_TRANSIT kinds, original IDs, immutable property binding and
movement streams. The existing one-location-per-property constraint remains
authoritative. No parallel location directory, balance table or financial
engine is introduced.

Reviewed, reasoned create, rename, retire and restore commands require
independent organization inventory-location authority. Property locations
additionally require held and current unconditional access to the actual
property. Query scopes are derived through the existing authorization
evaluator, then applied to both held and current property sources in SQL.
Catalog and property-choice pages remain bounded at fifty rows and preserve
tenant isolation, including installations with more than five hundred sites.

Retirement checks the actual derived quantity of every item at the location.
Opposite quantities in different item streams cannot cancel this condition.
Metadata changes and field stocktakes share the original location lock;
kind or property changes require another physical location. No stock is
moved by renaming, retiring or restoring metadata.

Native immutable audits and outbox receipts preserve exact command results
and nonce-only recovery. Negative acknowledgements fence delayed originals.
Audit disclosure independently rechecks the actual property source; an
inventory grant or broad audit grant alone cannot reveal private room names.
Private responses and drafts are discarded on hidden, offline and restored
browser pages. New stock movements continue in F-INV-03.
