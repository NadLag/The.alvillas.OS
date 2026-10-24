# ADR 0060: Refresh after service worker activation

Date: 2026-10-24

Status: Accepted

Native mobile PWA acceptance repeatedly stalled a document reload during an explicit worker update. The existing helper treated a `skipWaiting()` acknowledgement as readiness and also reloaded unconditionally after its message timeout. A deterministic lifecycle test reproduces premature reload while the replacement is still `activating`.

Require the replacement worker's `activated` state before reloading. Listen for state changes and use the existing bounded timeout to recover a missed notification by reading the state. If activation stalls, the worker becomes redundant or its message fails, preserve the current page and queued work, clear the update-in-progress flag and show the existing translated retry notice. Current unsaved-work and connection checks run again immediately before an allowed reload. No controller-change notification is required.

The [worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorker/state) distinguishes activation from acknowledgement; [`skipWaiting()`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/skipWaiting) resolves after an activation attempt. Unit tests cover early acknowledgement, missing notifications, stalled activation, absent waiting worker and message failure. Native desktop/mobile EN/FR/RTL PWA tests retain their original reload, queue, completion, accessibility and cache assertions. Failure diagnostics are bounded and do not change acceptance.
