# 0288. Owner property condition

Accepted for F-MNT-05.

The owner portal derives a property condition from open original Operations issues and their registered work orders. An open issue waiting for work takes precedence over work underway. Both the property list and detail page use the same status rules.

The query checks current owner access and returns only condition signals for authorized properties. The portal renders a localized aggregate status.
