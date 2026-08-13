---
status: accepted
---

# Use Tauri with a supervised TypeScript status service

Use Tauri 2 as the macOS presentation runtime and keep the existing TypeScript
status service as a separately bundled Bun helper under current-login-session
supervision. Tauri is the only tested candidate whose production-shaped
topology satisfies [ADR 0001](./0001-independent-status-service-lifecycle.md):
the presentation surface can close or quit while one authoritative status
service remains available to Stream Deck, abnormal service exits recover, and
explicit Stop holds. The Rust code remains a thin native presentation and
lifecycle adapter; it does not take ownership of provider or service behavior.

## Evidence and trade-off

Both spikes package the real dashboard, Herdr provider, lifecycle controls, and
native WebKit presentation. Their checked-in measurements used the same
MacBookPro18,1 with an Apple M1 Pro, 32 GiB memory, macOS 26.5, and the same
[release measurement protocol](../measurements/protocol.md). They were not
contemporaneous repeats: Electrobun was measured on 2026-07-23 from commit
`bbc6b6e` and Tauri on 2026-08-12 from commit `d9576c9`. Both records correctly
mark the repository dirty because each measured its then-uncommitted spike.
The JSON artifacts are the source of truth, so the displayed values support a
directional comparison but not precision beyond the recorded runs.

| Criterion                      | Electrobun 1.18.1                                                                                                                                                                                                                               | Tauri 2.11.5 with Bun 1.3.14 helper                                                                                                                                                                                                                                 | Decision effect                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lifecycle correctness          | Close destroys the WebKit presentation while the embedded service continues, and Stop holds while the main process remains alive. Quitting, crashing, or killing the main process also kills the service; there is no operating-system restart. | The launchd-supervised helper survives window close and full presentation quit. Stop unloads the job and holds; an abnormal helper exit is restarted during the current login session.                                                                              | Tauri satisfies ADR 0001 without redefining Quit or weakening the accepted lifecycle. This is decisive.                                                                                                                                                      |
| Developer workflow             | The application and service stay in TypeScript/Bun. The recorded developer build/reload took 3,076.25/1,692.51 ms.                                                                                                                              | Routine provider and dashboard work remains `bun run dev` and TypeScript-only. Native packaging adds Rust, Cargo, and a pinned Tauri CLI; the recorded native build/reload took 21,582.50/13,967.68 ms.                                                             | Accept Tauri's slower, separate native loop to preserve the fast routine TypeScript loop and the required lifecycle.                                                                                                                                         |
| Idle resource use              | Open/closed RSS was 83.79/52.00 MiB; CPU was 0.32%/0.10%; wakeups were 0.10/0.00 per second.                                                                                                                                                    | Open/closed RSS was 86.10/58.13 MiB; CPU was 1.24%/1.21%; wakeups were 0.00/0.00 per second.                                                                                                                                                                        | Electrobun is lighter in the recorded RSS and CPU samples. Tauri's higher use is a cost to monitor, not a measured disqualification of the TypeScript service. Small differences and zero wakeup samples should not be generalized beyond these runs.        |
| Installed and distributed size | 65.28 MiB installed and 17.42 MiB compressed DMG.                                                                                                                                                                                               | 70.14 MiB installed and 25.48 MiB compressed DMG; the bundled Bun executable dominates the package.                                                                                                                                                                 | Electrobun is smaller. Tauri's recorded increase is acceptable for a self-contained application and does not justify a service rewrite.                                                                                                                      |
| Startup behavior               | 498.62 ms from packaged launch through control, health, and snapshot readiness; reconnect took 97.88 ms.                                                                                                                                        | 3,562.77 ms startup and 746.13 ms reconnect. The spike's documented confirmation varied materially, so startup is explicitly noisy.                                                                                                                                 | Electrobun is faster. Tauri startup remains usable but needs regression tracking; this single run is not a latency guarantee.                                                                                                                                |
| Update behavior                | Stable packaging emitted an update archive and metadata, but the spike did not exercise production update replacement. Any update flow that terminates the single main process also interrupts its embedded service.                            | The spike emitted an app and DMG but did not install an updater or exercise replacement. Its separate service can outlive the presentation, but an update must coordinate the running launchd helper with replacement of its bundled runtime and service resources. | Neither candidate has proven production updates. Tauri must add and smoke-test signed update replacement while preserving endpoint, settings, lifecycle semantics, and an explicit Stop. Electrobun's generated update files are not proof of that behavior. |
| Packaging complexity           | A direct TypeScript workflow produces app, DMG, and update artifacts, but the spike relies on a required `index.js` layout and pinned internal imports that must be revalidated on upgrades. Signing and notarization were disabled.            | Packaging requires Rust/Cargo, target-specific Bun bundling, standalone service resources, sidecar naming, and launchd integration. The spike's ad-hoc signature passes local strict verification only.                                                             | Tauri is more complex. That complexity is isolated at the native/lifecycle boundary and buys the required process topology. Neither spike has completed Developer ID signing, hardened-runtime validation, notarization, stapling, or Gatekeeper testing.    |

## Consequences

- Keep the TypeScript service. The measured Tauri package is larger and slower
  than Electrobun, but the service remained healthy within the tested resource
  envelope. Under the spec's measured-disqualification rule, there is no
  evidence for paying the permanent cross-language cost of a Rust rewrite.
- Preserve launchd as the sole supervisor of the service. Tauri invokes the
  public status, start, stop, and restart operations and remains a presentation
  surface, not a second state owner or process supervisor.
- Keep native packaging and lifecycle work separate from routine
  `bun run dev`. Track Tauri's idle CPU, startup, reconnect, build, and reload
  costs as the production implementation evolves.
- Before distribution, implement and test Developer ID signing, notarization,
  stapling, Gatekeeper launch, and update replacement. The Tauri spike's
  ad-hoc signature establishes local bundle integrity only; it does not solve
  release signing or notarization.
- Electrobun remains evidence for the value of a TypeScript-first workflow and
  a useful efficiency baseline. It is rejected as the selected topology, not
  because of its performance, but because its embedded service cannot satisfy
  independent lifetime under actual application termination.
