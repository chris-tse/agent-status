# Electrobun Production-Shaped Spike

## Outcome

Electrobun 1.18.1 can package the existing Bun status service, Herdr provider,
and React dashboard as a compact native-WebKit macOS application with useful
tray and application-menu controls. The measured stable build starts quickly
and releases its WebContent and networking processes when the dashboard closes.

The spike does **not** satisfy the independent service lifetime in
[`ADR 0001`](../adr/0001-independent-status-service-lifecycle.md). Its service
runs inside Electrobun's Bun main process. Product-level Close can preserve the
service, but terminating the main process always terminates it, and there is no
operating-system supervision to restart it. Electrobun remains a viable
presentation/runtime candidate only if the production design moves the service
to the existing independent launchd lifecycle or deliberately changes the
accepted lifecycle requirement.

## Production-shaped contents

- Exact runtime: `electrobun@1.18.1`, pinned rather than ranged.
- One Electrobun Bun main process containing the real
  `@status-dashboard/service` and real Herdr provider.
- Existing Vite/React dashboard copied into the application and loaded from
  `views://dashboard/index.html` with relative production assets.
- Native macOS WebKit renderer; CEF is not bundled.
- Menu bar item and application menu with Show Dashboard, Close Dashboard,
  Start Service, Stop Service, Restart Service, and Stop Service and Quit.
- Loopback service endpoint at `127.0.0.1:4317`.
- A separate loopback control endpoint at `127.0.0.1:4318` for repeatable
  lifecycle smoke tests and measurements.
- Stable macOS packaging that produces an expanded `.app`, DMG, compressed
  update archive, and update metadata.

The implementation follows the official
[Electrobun 1.18.1 source](https://github.com/blackboardsh/electrobun/tree/v1.18.1)
and its
[React/Vite template](https://github.com/blackboardsh/electrobun/tree/v1.18.1/templates/react-tailwind-vite).

## Lifecycle semantics

| User action                                | Dashboard         | Service                      | Main process        |
| ------------------------------------------ | ----------------- | ---------------------------- | ------------------- |
| Open application                           | Opens             | Starts if stopped            | Running             |
| Close Dashboard or Cmd-W                   | Destroyed         | Continues                    | Running in menu bar |
| Show Dashboard after Close                 | Recreated         | Existing state reused        | Running             |
| Stop Service                               | Unchanged         | Stops and stays stopped      | Running             |
| Show Dashboard after Stop                  | Recreated         | Remains stopped              | Running             |
| Start Service                              | Unchanged         | Starts                       | Running             |
| Restart Service                            | Unchanged         | Stops, then starts           | Running             |
| Stop Service and Quit or Cmd-Q             | Destroyed by exit | Stops first                  | Exits               |
| Dock Quit, Force Quit, crash, kill, logout | Destroyed         | Terminates with main process | Exits               |

`exitOnLastWindowClosed` is disabled, so closing the presentation does not
implicitly quit the application. The window is destroyed rather than hidden,
which removes the WebContent and networking processes while the status service
continues. An explicit Stop remains in effect when the dashboard is shown
again; only Start Service or a fresh application launch starts it.

The phrase “Quit presentation” therefore maps to **Close Dashboard** in this
spike. There is no separate presentation process to quit. A true application
quit is a main-process termination and cannot preserve the embedded service.
The application menu maps Cmd-Q to the safe **Stop Service and Quit** path, but
macOS or an external signal can still terminate the main process without a
separately supervised service surviving.

## Packaged lifecycle smoke test

The stable `.app` was launched through its packaged
`Contents/MacOS/launcher`, not through a development server:

1. Launch opened the dashboard and returned a compatible `/health` response
   from the real Herdr-backed service.
2. Close Dashboard destroyed the presentation; `/health` remained available.
3. Stop Service made the service endpoint unavailable.
4. Show Dashboard recreated the presentation without restarting the explicitly
   stopped service.
5. Start Service restored health and a current dashboard snapshot.
6. Stop Service and Quit stopped the endpoint and exited the main process.

When Herdr's socket is absent, provider state reports disconnected and retries;
the local status service remains healthy.

## Measurements

The shared release protocol recorded
[`Electrobun-1.18.1-0.1.0-stable-macos-arm64`](../measurements/results/Electrobun-1.18.1-0.1.0-stable-macos-arm64-2026-07-23T07-04-40-488Z.json)
on a MacBookPro18,1 with an Apple M1 Pro, 32 GiB memory, and macOS 26.5.

| Measure                        |     Result |
| ------------------------------ | ---------: |
| Compressed DMG                 |  17.42 MiB |
| Expanded installed application |  65.28 MiB |
| Dashboard-open RSS             |  83.79 MiB |
| Dashboard-closed RSS           |  52.00 MiB |
| Dashboard-open idle CPU        |      0.32% |
| Dashboard-closed idle CPU      |      0.10% |
| Dashboard-open wakeups         |     0.10/s |
| Dashboard-closed wakeups       |     0.00/s |
| Startup                        |  498.62 ms |
| Service reconnect              |   97.88 ms |
| Developer build                | 3076.25 ms |
| Developer reload               | 1692.51 ms |

The result is a working-tree measurement of this spike, so its source metadata
correctly records `repositoryDirty: true`. Startup measures the packaged
launcher through successful control, health, and snapshot readiness. It does
not include Finder or DMG-install overhead, and dashboard readiness does not
inspect rendered DOM pixels. Reconnect restarts the embedded service and waits
for service health plus a current snapshot.

Electrobun's native WebKit renderer processes are reparented to `launchd` on
macOS. The measurement adapter snapshots existing WebKit processes before
launch and includes the new candidate GPU, networking, and WebContent
processes, even though they are not descendants of the main PID. After Close,
the WebContent and networking processes exit while the GPU process remains.

## Developer workflow

From the repository root:

```sh
# Rebuild workspace dependencies and dashboard, then run watched Electrobun dev
bun run --filter '@status-dashboard/electrobun' dev

# Build a quick dev package without starting the watcher
bun run --filter '@status-dashboard/electrobun' build:dev

# Build the stable macOS package used by the measurement
bun run --filter '@status-dashboard/electrobun' build:release

# Exercise the same release-measurement adapter
bun run measure:release --config docs/measurements/configs/electrobun.json
```

Stable outputs are below `apps/electrobun/.electrobun/` and are ignored by Git.
The application is self-contained and does not require a separate Bun or Node
installation on the target machine.

## Packaging findings and limitations

- Electrobun 1.18.1's packaged launcher expects the Bun entry bundle to be
  named `index.js`. A configured `src/main.ts` compiled and packaged but then
  launched without the app because the runtime still looked for
  `app/bun/index.js`. The spike therefore uses `src/index.ts`.
- Importing the public `electrobun/bun` barrel pulled unrelated Three,
  Babylon, and WebGPU modules plus their top-level side effects into the main
  bundle. Exact imports from Electrobun's shipped core modules reduced the
  development Bun bundle from roughly 5.8–7.1 MB to about 469 KB. These internal
  import paths are brittle, which is another reason the dependency is pinned
  exactly and must be revalidated during upgrades.
- Launch Services `open -n` was unreliable for this locally produced unsigned
  stable application. Directly invoking `Contents/MacOS/launcher` is stable and
  is the recorded measurement path.
- Code signing and notarization are deliberately disabled in this spike.
  Although the packager produces a DMG, it is not a production-distributable
  signed and notarized release. Credentials, hardened-runtime validation, and a
  Gatekeeper smoke test remain required.
- The control server exists solely to make lifecycle and measurement actions
  deterministic. It is loopback-only, but a production build should remove it
  or gate and authenticate it.
- The spike exposes lifecycle actions, but its menu labels do not yet display
  transition, provider-connectivity, or error state, and it does not expose
  diagnostic logs.
- The single-process service does not reuse the compatible-listener detection,
  abnormal-exit supervision, or current-login-session behavior already
  implemented by the independent launchd lifecycle.

The principal trade-off is now concrete: Electrobun offers an unusually direct
TypeScript workflow and modest native-WebKit packaging, while the embedded
topology fails the accepted requirement that service lifetime be independent of
the presentation host. A follow-up runtime decision should compare this result
against a candidate wired to the independent service rather than relaxing that
constraint implicitly.
