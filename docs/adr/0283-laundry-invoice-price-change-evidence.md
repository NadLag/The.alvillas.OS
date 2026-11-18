# ADR 0283 — Original invoice evidence for supplier price changes

An actual laundry invoice retains native whole invoice lines. A total difference
can reflect quantity, damage, taxes or other charges and does not prove a unit rate.

The existing supplier-price workflow therefore copies the latest version in the
original scope and requires confirmation of supplier-stated unit rates from the
original invoice and receipt. Only affected linen rates may change; currency,
billing terms, catalog units and unrelated prices are retained. A new native
configuration version and its immutable price receipt preserve the association,
reviewed source fingerprint and original basis version. Existing configuration
authorization, effective dates, audit, nonce recovery and source guards apply.

This comparison never changes an earlier quote, expected invoice, actual invoice,
posting, payable or stock movement. Currency mismatch has no automatic conversion.
