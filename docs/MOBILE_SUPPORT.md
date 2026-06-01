# Mobile Browser Support — Research & Roadmap

This document summarizes realistic options for extending Mergen beyond desktop Chrome into mobile browser and mobile WebView environments. The short version: mobile support is possible, but browser extension parity does not exist today across platforms, so the implementation strategy needs to differ by environment.

## Current State

### What works today

- Desktop Chrome extension model is the primary supported path.
- Browser-side JavaScript can capture console output, network activity, and selected page context.
- Any environment that can POST compatible JSON to Mergen’s local `/ingest` endpoint can participate in the broader architecture.
- React Native and Flutter WebViews are technically capable of sending equivalent events through an injected bridge.

### What does not work today

- There is no first-class mobile browser extension story equivalent to desktop Chrome for Mergen’s current extension architecture.
- iOS Safari does not offer a simple drop-in extension model for arbitrary page-level debugging instrumentation.
- Chrome on Android does not currently provide a general extension platform comparable to desktop Chrome stable.
- Localhost networking on mobile devices is more complicated because the browser, app, simulator, and development machine may not share the same loopback semantics.

## Chrome for Android

### Extension Manifest V3 support status

Chrome for Android does **not** currently offer the same broadly available extension runtime as desktop Chrome. Even though Manifest V3 defines the modern Chrome extension model, that does not mean MV3 extensions can simply be loaded and used on Android Chrome the same way.

### Practical limitations

- No reliable user-facing path for loading and running arbitrary debugging extensions in standard Chrome for Android.
- Background/service-worker lifecycle assumptions from desktop extensions do not translate cleanly.
- Content-script injection is not something Mergen can rely on in stock Chrome for Android.
- Even if experimental extension support appears in some Chromium variants, it would not be a stable product strategy.

### Possible workarounds

- **Bookmarklet-based injection** for pages you control during development.
- **Remote debugging bridge** where the mobile page forwards events to a desktop relay rather than directly to mobile localhost.
- **Alternative browsers** with limited extension support, though this fragments the experience and weakens the product story.

### Honest assessment

Chrome for Android is not a good near-term target for the current extension implementation. A different injection or SDK approach is more realistic.

## Safari iOS (WKWebView)

### App Extensions and Content Blockers

Safari on iOS supports web extensions in a much more constrained environment than desktop browsers, and WKWebView can be instrumented by native apps. However, neither option is a clean drop-in replacement for Mergen’s existing Chrome extension architecture.

### Limitations

- Safari iOS extension support is constrained and operationally heavier than desktop extension workflows.
- Content Blockers are designed for declarative request/content filtering, not rich runtime instrumentation.
- Full console/network capture from arbitrary pages is not as straightforward as injecting a desktop-style content script.
- Shipping and maintaining an iOS extension means native Apple platform work, signing, packaging, and a different release process.

### WKWebView-specific opportunity

If the target environment is your own app using `WKWebView`, instrumentation is much more feasible:
- inject JavaScript into the web view at document start
- override console methods
- wrap `fetch` / `XMLHttpRequest`
- send events back through native message handlers
- forward normalized JSON into the same Mergen `/ingest` contract

### Honest assessment

General Safari iOS support is a significant product effort. WKWebView support inside apps you control is much more realistic.

## React Native WebView

React Native WebView is one of the most promising short-to-medium-term mobile paths because it already supports injecting JavaScript and bridging messages back to native code.

### Approach

Inject a trimmed version of Mergen’s content script using `injectedJavaScript` or `injectedJavaScriptBeforeContentLoaded`, then forward events through `window.ReactNativeWebView.postMessage(...)`.

Example shape:

```js
(function () {
  const originalError = console.error;
  console.error = function (...args) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'console',
      level: 'error',
      args,
      url: location.href,
      timestamp: Date.now()
    }));
    return originalError.apply(console, args);
  };
})();
```

The native layer can then:
- batch or forward events
- redact sensitive keys
- POST to a local or remote development relay
- keep the event shape compatible with the desktop Mergen server

### Constraints

- Network interception in WebView contexts is possible but not identical to browser extension interception.
- Message bridge overhead can become noticeable if events are extremely noisy.
- Localhost may need to refer to the device itself, not the development machine; a LAN-accessible relay or adb/port forwarding may be required.

## Flutter WebView

Flutter has a similar opportunity profile to React Native.

### Approach

Use a WebView plugin that supports JavaScript injection and JavaScript channel messaging. Inject a Mergen-compatible script, serialize events to the Flutter side, and forward them to the same ingest format.

High-level flow:
- inject script on page load
- patch console methods and network APIs where possible
- send JSON through a JavaScript channel
- forward to `/ingest` or a desktop relay endpoint

### Constraints

- Plugin capabilities vary across iOS and Android.
- Request/response body capture may be partial depending on platform hooks.
- Like React Native, localhost semantics are the main operational hurdle.

## Recommended Short-Term Approach

### Bookmarklet injection for mobile debugging sessions

The most realistic short-term approach is a **bookmarklet** that injects a minimized version of `content.js` into pages you control during mobile debugging sessions.

Why this is attractive:
- no browser-store distribution required
- no full native app required
- works as an opt-in development tool
- keeps the event schema aligned with the existing Mergen server

What it would do:
- inject lightweight console and fetch/XHR instrumentation
- capture a reduced context snapshot
- POST to a developer-configured ingest endpoint reachable from the device

Limitations:
- only practical on pages that allow script injection in this way
- awkward UX compared with a true extension
- not suitable for general consumer browsing scenarios
- may be blocked by CSP or platform restrictions

## Recommended Long-Term Approach

### Native SDK approach using the same `/ingest` endpoint

The strongest long-term path is **not** to chase perfect mobile browser extension parity. It is to provide a native mobile SDK or bridge layer that emits the same Mergen event schema.

That approach would:
- preserve compatibility with the existing ingest and MCP layers
- support React Native, Flutter, WKWebView, and potentially native app network logging
- avoid depending on fragile mobile browser extension support
- allow better privacy controls and more predictable delivery

Conceptually, the mobile implementation should treat the schema as the product boundary. Once events are normalized into the same format, the rest of Mergen can stay mostly unchanged.

## Effort Estimates

| Approach | Estimated effort | What you get | Main limitations |
|---|---|---|---|
| Bookmarklet injection | 1–2 weeks | Quick experimental mobile debugging on controlled pages | Fragile UX, CSP restrictions, limited reach |
| React Native WebView bridge | 2–4 weeks | Strong support for RN apps using WebView | Requires app integration, localhost/relay complexity |
| Flutter WebView bridge | 2–4 weeks | Similar capability for Flutter apps | Plugin/platform variance, app integration required |
| WKWebView native bridge | 3–6 weeks | Good support for iOS apps you control | Apple-specific implementation and packaging work |
| Full Safari iOS extension path | 6–10+ weeks | Broader Apple-browser story | Significant platform complexity, uncertain capture parity |
| Chrome Android extension parity attempt | High / not recommended | Unclear payoff | Platform support is not dependable today |
| Native cross-platform SDK | 6–12+ weeks | Durable long-term architecture | Larger product and maintenance scope |

## Recommendation Summary

If the goal is to learn quickly, start with a bookmarklet and one WebView integration path.

If the goal is broad, durable mobile support, define the mobile product around the **open event schema** and build native bridges or SDKs that feed the same ingest endpoint. That aligns with Mergen’s architecture better than trying to force desktop extension assumptions onto mobile browsers.

## Open Questions

- Should mobile events go directly to device localhost, or to a paired desktop relay during development?
- How much request/response body capture is acceptable on constrained mobile devices?
- What subset of context snapshot data is useful enough to justify collection cost?
- Should mobile support focus on app-embedded WebViews first instead of general mobile browsers?

For now, the honest answer is: mobile support is feasible, but it needs a different implementation strategy than the desktop Chrome extension.
