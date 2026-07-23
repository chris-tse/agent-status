# Production Desktop Runtime

## Problem Statement

The Ambient Status Dashboard currently proves that provider state can flow
through a local status service to a browser dashboard and Stream Deck. Using it
still requires development commands, manually managed processes, and knowledge
of local endpoints. The dashboard cannot yet be installed and operated as a
normal macOS application, and the lifecycle of its presentation surfaces has
not been separated from the lifecycle required by ambient consumers.

The user needs a low-friction desktop product that starts the status service
when requested, keeps Stream Deck status available after the desktop surface is
closed, exposes obvious lifecycle and diagnostic controls, and consumes few
resources while running in the background. The implementation must remain
pleasant to evolve for a TypeScript-heavy maintainer rather than optimizing
binary size at the expense of ongoing development velocity.

## Solution

Provide an installable, signed macOS desktop application that presents the
existing React dashboard and controls one authoritative local status service.
Opening the desktop application starts the service when it is stopped. Closing
or quitting the presentation surface does not stop an active service, allowing
Stream Deck to remain connected. The desktop application exposes explicit
status, start, stop, and restart controls.

The service is not launched automatically at login. Once activated, it is
supervised for the current login session and recovers from abnormal exits.
Explicitly stopping it prevents restart, and logout or reboot returns it to the
stopped state.

Before selecting the final desktop runtime, build a focused production-shaped
spike that measures a TypeScript-first implementation against the required
lifecycle. Evaluate developer workflow, idle memory, idle CPU and wakeups,
installed size, distributable size, startup latency, reconnection latency, and
packaging complexity. Do not rewrite the status service in Rust unless measured
constraints justify the permanent cross-language development cost.

## User Stories

1. As a user, I want to install one normal macOS application, so that I do not
   need repository tooling to use the dashboard.
2. As a user, I want to launch the desktop application manually, so that the
   product does not consume resources merely because I logged in.
3. As a user, I want launching the desktop application to start the status
   service when necessary, so that startup requires no terminal commands.
4. As a user, I want opening the desktop application while the service is
   already running to reuse that service, so that duplicate instances cannot
   compete for state or ports.
5. As a user, I want the desktop application to display whether the service is
   stopped, starting, running, restarting, or unhealthy, so that its lifecycle
   is understandable.
6. As a user, I want to start the service explicitly from the desktop
   application, so that I can recover after intentionally stopping it.
7. As a user, I want to stop the service explicitly from the desktop
   application, so that I can end all background activity when desired.
8. As a user, I want to restart the service from the desktop application, so
   that I can recover from a degraded provider or configuration without using a
   terminal.
9. As a user, I want closing or quitting the desktop presentation surface to
   leave an active service running, so that Stream Deck remains useful.
10. As a user, I want an explicit way to stop the service before leaving the
    desktop application, so that continued background operation is always a
    deliberate choice.
11. As a user, I want the service to remain stopped after I stop it, so that it
    cannot silently reactivate during the same login session.
12. As a user, I want logout or reboot to end the service, so that it does not
    become an automatic login item.
13. As a user, I want opening the desktop application after a reboot to start
    the service again, so that the manual-start workflow remains predictable.
14. As a user, I want the operating system to restart an unexpectedly crashed
    service during the active login session, so that transient failures do not
    permanently disable ambient status.
15. As a user, I want the desktop dashboard to receive an immediate current
    snapshot, so that it is useful as soon as it opens.
16. As a user, I want status changes to arrive through a live push connection,
    so that updates are timely without periodic application polling.
17. As a Stream Deck user, I want keys to receive the same normalized status as
    the desktop dashboard, so that both surfaces agree.
18. As a Stream Deck user, I want the plugin to reconnect automatically after
    service startup or restart, so that lifecycle controls require no Stream
    Deck intervention.
19. As a Stream Deck user, I want assigned resources to remain stable through
    status changes, so that physical key locations retain meaning.
20. As a Stream Deck user, I want a clear offline state while the service is
    stopped, so that missing data is not confused with healthy empty state.
21. As a Stream Deck user, I want reconnect attempts to remain unobtrusive, so
    that an intentionally stopped service does not cause distracting key
    activity.
22. As a Herdr user, I want the service to reconnect to Herdr independently of
    presentation surfaces, so that closing a dashboard cannot disrupt
    collection.
23. As a user, I want provider connectivity and failure details available from
    the desktop application, so that I can distinguish a service failure from a
    Herdr failure.
24. As a user, I want diagnostic logs available through an obvious desktop
    action, so that failures can be investigated without locating hidden files.
25. As a user, I want the service bound only to the local machine, so that
    dashboard state is not exposed to the network.
26. As a user, I want an unrelated process occupying the configured endpoint to
    produce a clear error, so that the application does not connect to or
    terminate the wrong process.
27. As a user, I want application updates to preserve the expected service
    lifecycle, endpoint, and settings, so that upgrading does not strand either
    consumer.
28. As a user, I want the installed application to include everything it needs,
    so that a separate Bun or Node installation is not required.
29. As a maintainer, I want provider-specific concepts confined to provider
    integrations, so that presentation surfaces continue to consume one shared
    model.
30. As a maintainer, I want one authoritative service instance, so that state
    ownership and event ordering remain unambiguous.
31. As a maintainer, I want desktop-runtime code to remain thin around the
    existing service interface, so that framework selection does not force a
    rewrite of domain behavior.
32. As a TypeScript-heavy maintainer, I want to preserve the existing
    TypeScript service unless measurements disqualify it, so that adding and
    debugging providers remains approachable.
33. As a maintainer, I want one development command to run the service and web
    dashboard without native packaging, so that routine provider and UI work
    keeps a fast feedback loop.
34. As a maintainer, I want a separate command for exercising the packaged
    desktop lifecycle, so that native integration is tested without slowing
    every development task.
35. As a maintainer, I want release measurements recorded reproducibly, so that
    runtime selection is based on evidence rather than advertised bundle sizes.
36. As a maintainer, I want protocol compatibility identified in service
    health, so that consumers and desktop controls can detect incompatible
    versions.

## Implementation Decisions

- The current repository is a behavioral prototype, not a constraint that the
  production packaging or process topology must preserve.
- One local status service owns provider connections, normalized resources,
  events, ordering, and snapshots. Presentation surfaces never become
  authoritative state owners.
- Providers communicate with the service, and presentation surfaces consume
  service state. Providers do not communicate directly with presentation
  surfaces.
- The desktop dashboard and Stream Deck continue to consume a provider-neutral
  HTTP and WebSocket interface.
- The service remains push-based while connected. HTTP snapshot retrieval is
  reserved for initial state and recovery.
- The service binds to loopback on a stable endpoint. Its health response
  carries application and protocol identity, allowing lifecycle controls to
  distinguish the expected service from an unrelated listener.
- Only one service instance may own the endpoint. Starting an already-running
  compatible instance is idempotent; an incompatible listener is an explicit
  failure.
- Opening the desktop application automatically activates the service when it
  is stopped. The service is not activated at login.
- The service lifecycle is independent from every presentation surface.
  Closing or quitting the desktop presentation does not imply service shutdown.
- Explicit Stop deactivates the service and prevents crash supervision from
  restarting it. Restart is a controlled Stop followed by Start.
- While active, the service is supervised for abnormal exits during the current
  login session. Logout or reboot does not preserve active registration.
- The desktop application reports service and provider connectivity as
  different states.
- The desktop runtime must destroy unused dashboard windows rather than merely
  hide renderers when the selected framework permits it.
- The production application is self-contained and directly distributable as a
  signed and notarized macOS application.
- TypeScript remains the preferred status-service implementation. A Rust
  rewrite is not part of the initial solution and requires evidence that the
  TypeScript runtime cannot meet agreed resource constraints.
- The final desktop framework is not selected by this spec. A production-shaped
  spike must compare lifecycle correctness, developer workflow, idle resource
  use, installed and distributed size, startup behavior, update behavior, and
  native packaging.
- Electrobun is a valid spike candidate because it can reuse the existing Bun
  service and React dashboard. A single Electrobun main process only satisfies
  independent lifecycle if product-level Close and Quit semantics are made
  explicit; terminating that process necessarily terminates its service.
- Tauri with a separately supervised TypeScript helper is a valid spike
  candidate because it satisfies independent service lifetime directly, at the
  cost of bundling and supervising a JavaScript runtime.
- Resource measurements distinguish compressed download size, installed size,
  idle resident memory, idle CPU, wakeups, and window-renderer overhead. None
  may be substituted for another.
- The existing demo provider remains available for development and automated
  acceptance testing but is not presented as a production integration.
- Stream Deck process management is forbidden. The plugin observes connection
  state and reconnects; it never starts, stops, or supervises the service.

## Testing Decisions

- Good tests assert externally observable behavior through a stable module
  interface. They do not assert private maps, timer fields, framework callbacks,
  or other implementation details.
- The primary automated acceptance seam is the assembled local status service.
  Tests start it with a controlled provider and clock, then interact through
  real HTTP and WebSocket connections as consumers do.
- Acceptance coverage includes initial snapshots, sequential pushed updates,
  stale-update behavior, recovery after reconnect, provider connectivity,
  endpoint identity, single-instance behavior, graceful shutdown, and abnormal
  provider failure.
- The existing store, provider, wire-state, slot-pool, and dashboard snapshot
  tests remain useful prior art for focused contract behavior.
- Desktop lifecycle logic is tested through its public status, start, stop, and
  restart operations. Tests assert process and health outcomes rather than
  native framework callback order.
- Consumer contract tests verify that the dashboard and Stream Deck accept the
  same snapshot and update messages and recover from service restart.
- Packaged macOS smoke tests verify launch, automatic service activation,
  window close, presentation quit, service survival, explicit stop, restart,
  crash recovery, logout behavior where practical, code signing, notarization,
  and update replacement.
- Physical Stream Deck smoke tests verify offline display, reconnection, stable
  slot assignment, and absence of distracting retry flashes.
- Runtime spikes use reproducible release builds and record installed size,
  compressed distribution size, idle resident memory with the dashboard open
  and closed, idle CPU and wakeups, startup time, reconnect time, and developer
  build/reload time.
- A framework is not selected from hello-world measurements alone. The measured
  build must include the real service, Herdr provider, dashboard, tray or menu
  controls, and production packaging mode.

## Out of Scope

- Rewriting the status service in Rust before measurements demonstrate a need.
- Automatically starting the product at login.
- Windows or Linux desktop packaging.
- Mac App Store distribution or sandboxing; direct signed and notarized macOS
  distribution is the initial target.
- Multi-provider composition beyond the currently selected provider.
- Durable resource, event, or slot persistence across service restarts.
- New provider integrations beyond Herdr and the development simulator.
- Stream Deck actions such as focusing a workspace or acknowledging an event.
- Starting or supervising the service from the Stream Deck plugin.
- Remote-network or multi-machine access to dashboard state.
- Mobile clients, notifications, and additional hardware surfaces.
- Final visual branding and marketplace artwork.

## Further Notes

- The independent-service lifecycle is recorded in
  `docs/adr/0001-independent-status-service-lifecycle.md`.
- The broader product intent and provider/presentation separation remain in
  `docs/product-brief.md`.
- The final desktop-runtime decision should become a separate ADR only after the
  production-shaped spike produces measurements and a genuine trade-off is
  resolved.
- “Close,” “Quit presentation,” “Stop service,” and “Stop service and quit”
  require deliberate product language. Framework defaults must not silently
  define these semantics.
