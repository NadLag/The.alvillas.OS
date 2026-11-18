# ADR 0291. Supplier price and performance alert sources

Supplier prices use immutable configuration versions on the canonical supplier. Delivery requires independent financial and supplier authority. Performance notices use the original Maintenance assignment, approved SLA and Operations milestones, with current property and task authorization.

Effective price changes and each breached milestone are delivered once through the shared outbox and configured notification routing.
