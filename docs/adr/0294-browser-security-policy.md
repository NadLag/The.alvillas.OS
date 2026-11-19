# Browser security policies

F-SEC-04 adds default security headers and generates a request nonce for private and secret-link documents through Next.js Proxy. Next receives the policy before rendering so its framework scripts carry the nonce. Private navigation omits referrer data. The service worker retains its separate, same-origin policy.

Public static pages carry a policy that restricts scripts to the application and its inline framework bootstrap while blocking inline event handlers. This preserves the public performance budget. The private policy admits nonce-bearing scripts and preserves existing inline styles. Browser connections admit the configured R2 account for signed uploads. Local development adds the capabilities required by the framework debugger and development socket. Hosted acceptance covers signed photo upload, identity and secret-link entry points on the verified deployment.
