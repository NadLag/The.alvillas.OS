# ADR 0060: Refresh after service worker activation

Date: 2026-10-24

Status: Accepted

Native mobile PWA acceptance repeatedly stalled a document reload during an explicit worker update. The existing helper treated a `skipWaiting()` acknowledgement as readiness and also reloaded unconditionally after its message timeout. A deterministic lifecycle test reproduces premature reload while the replacement is still `activating`.

Require the replacement worker's `activated` state and its adoption as the document's controller before reloading. The waiting slot can already be empty while `registration.active` is still activating; inspect that active replacement instead of treating an empty waiting slot as readiness. Listen for lifecycle changes and check readiness on a new task. Bounded polling also handles suppressed or missed controller/state notifications. If readiness stalls, the worker becomes redundant or its message fails, preserve the current page and queued work, clear the update-in-progress flag and show the existing translated retry notice. Current unsaved-work and connection checks run again immediately before an allowed reload.

The [W3C activation algorithm](https://w3c.github.io/ServiceWorker/#activation-algorithm) clears the waiting slot before completing activation; [controller](https://w3c.github.io/ServiceWorker/#dom-serviceworkercontainer-controller) identifies the worker controlling the document. A later complete browser run passed 149 journeys and stalled French desktop refresh. Two additional deterministic regressions fail against the earlier helper: activated state before controller adoption, and an activating active replacement after the waiting slot clears. Seven lifecycle cases cover those races, early acknowledgement, missing notifications, stalled activation, absent replacement and message failure. Native desktop/mobile EN/FR/RTL PWA tests retain their original reload, queue, completion, accessibility and cache assertions. Failure diagnostics are bounded and do not change acceptance.
