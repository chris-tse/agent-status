# Tauri Production-Shaped Spike

## Outcome

Tauri 2.11.5 packages the React dashboard in native WebKit while a bundled Bun
1.3.14 runtime executes the existing TypeScript service as an independent
launchd-supervised helper. Unlike the embedded Electrobun topology, closing the
dashboard or terminating the full Tauri presentation leaves the service healthy
for Stream Deck. Explicit Stop unloads the job and holds until a later Start or
application open.

The spike satisfies the independent lifetime in
[`ADR 0001`](../adr/0001-independent-status-service-lifecycle.md). Its costs are
a small Rust presentation shell, a 60 MiB bundled Bun executable, native build
tooling, and slower build/reload plus higher measured open-window CPU than the
Electrobun candidate.

## Production-shaped contents

- Exact native runtime: `tauri` 2.11.5, `tauri-build` 2.6.3, `tauri-cli` 2.11.1,
  and a committed Cargo lockfile.
- Existing Vite/React dashboard compiled into Tauri and loaded in native WebKit.
- Existing TypeScript service bundled with its real Herdr provider and run by a
  bundled Bun 1.3.14 arm64 executable. No target-machine Bun/Node is required.
- Native application and tray menus with Show, Close, Status, Start, Stop,
  Restart, Quit Presentation, and Stop Service and Quit controls.
- Existing current-login-session launchd controller as the sole process
  supervisor. Tauri never owns the service as a child process.
- Loopback service at `127.0.0.1:4317`, consumed through the same HTTP snapshot
  and WebSocket feed as Stream Deck.
- Optional loopback test control enabled only by
  `STATUS_DASHBOARD_CONTROL_PORT`; normal packaged launches do not expose it.
- Stable arm64 `.app` and DMG. The spike uses an ad-hoc signature that passes
  strict local verification; Developer ID signing/notarization need credentials.

## Bundling and supervision

`bun apps/tauri/scripts/prepare-helper.ts` copies the exact repository Bun
runtime to Tauri's target-triple sidecar name and bundles the service and
lifecycle CLI into standalone Bun-targeted JavaScript resources. Tauri installs
the runtime under `Contents/MacOS` and service code under
`Contents/Resources/service`.

The Rust shell invokes the installed lifecycle CLI. It generates a launchd
plist pointing to the installed runtime and service entrypoint, stores it below
Application Support, and bootstraps it into `gui/<uid>`. It is neither a login
item nor Tauri child state. Rust only translates native actions to public
`status`, `start`, `stop`, and `restart` calls and parses process/health results.
The packaged helper defaults to Herdr; missing Herdr reports provider
disconnection/retry while the local service stays healthy.

## Lifecycle behavior

| Action                        | Presentation        | Service                                       |
| ----------------------------- | ------------------- | --------------------------------------------- |
| Open application              | Window opens        | Starts if stopped; compatible instance reused |
| Close Dashboard or Cmd-W      | Window destroyed    | Continues                                     |
| Show after close              | Window recreated    | Existing instance reused                      |
| Quit Presentation / terminate | Tauri process exits | Continues                                     |
| Stop Service                  | Unchanged           | Stops and remains stopped                     |
| Restart Service               | Unchanged           | Old PID stops; healthy replacement starts     |
| Abnormal helper exit          | Unchanged           | launchd starts a healthy replacement          |
| Stop Service and Quit         | Tauri process exits | Stops first and remains stopped               |
| Logout or reboot              | Tauri process exits | GUI-session job is discarded                  |

Closing the final WebKit window normally asks Tauri to exit. The shell prevents
only the exit corresponding to window Close, so the renderer is destroyed while
the tray process remains. Explicit Quit is not prevented and does not call Stop.

A packaged restart exposed a race hidden by the synchronous test supervisor:
`launchctl bootout` can return while the old listener is draining, making an
immediate restart briefly classify the port as unrelated. The shared lifecycle
controller now waits for endpoint release after supervised deactivation.

## Packaged lifecycle smoke

```sh
bun run --filter '@status-dashboard/tauri' smoke
```

The smoke launches the packaged executable; verifies compatible health, a real
HTTP snapshot, and an immediate WebSocket snapshot; then proves Close and full
Tauri Quit survival, Stop hold, Start, Restart PID replacement, `SIGKILL`
recovery, and strict deep code-sign verification. Cleanup unloads launchd even
when an assertion fails.

## Measurements

The shared protocol
[result](../measurements/results/Tauri-2.11.5-Bun-1.3.14-helper-0.1.0-macos-arm64-2026-08-12T23-24-03-883Z.json)
and [`comparison.md`](../measurements/comparison.md) were recorded on a
MacBookPro18,1 (Apple M1 Pro, 32 GiB, macOS 26.5). The JSON correctly records
`repositoryDirty: true` because it measures this uncommitted spike.
The bundled Bun runtime dominates installed and compressed size. The open
process set includes Tauri, the launchd helper, and WebKit GPU, networking, and
WebContent; Close removes WebContent.

| Measure                        |      Result |
| ------------------------------ | ----------: |
| Compressed DMG                 |   25.48 MiB |
| Expanded installed application |   70.14 MiB |
| Dashboard-open RSS             |   86.10 MiB |
| Dashboard-closed RSS           |   58.13 MiB |
| Dashboard-open idle CPU        |       1.24% |
| Dashboard-closed idle CPU      |       1.21% |
| Open/closed wakeups            | 0.00/0.00/s |
| Startup                        |  3562.77 ms |
| Service reconnect              |   746.13 ms |
| Developer build                | 21582.50 ms |
| Developer reload               | 13967.68 ms |

The checked-in run measured 1.24% open and 1.21% closed CPU. An isolated full
protocol confirmation measured 1.22% and 1.16%, respectively, with the same
process-set and settle/sample rules. A preliminary run's 20.44% open result did
not reproduce after rebuilding with the production Herdr default; a manual
`ps %cpu` check was discarded because it is a lifetime average contaminated by
startup rather than the protocol's interval delta. Only the reproducible final
run is checked in. Startup varied from 3.56 seconds in the record to 2.06
seconds in confirmation, so selection should treat startup as noisier than the
stable size and idle-resource results.

## Developer workflow

Routine provider/dashboard work remains TypeScript-only:

```sh
bun run dev
```

Native commands are separate:

```sh
# One-time native tool install; preparation verifies this exact version
cargo install tauri-cli --version 2.11.1 --locked

bun run --filter '@status-dashboard/tauri' dev
bun run --filter '@status-dashboard/tauri' build:dev
bun run --filter '@status-dashboard/tauri' build:release
bun run --filter '@status-dashboard/tauri' smoke
bun run measure:release --config docs/measurements/configs/tauri.json
```

Generated helper inputs and Cargo targets are ignored. Committed inputs are the
preparation/control scripts, Rust source/configuration, icons, Cargo manifests
and lockfile, and measurement/docs artifacts.

## Packaging findings and limitations

- `externalBin` requires a Rust-target-triple filename; its installed
  `Contents/MacOS` basename drops the suffix, which Rust resolves at runtime.
- Service resources must be standalone bundles; they cannot depend on workspace
  links or ignored `dist` output.
- Copying Bun preserves the service but removes Tauri's tiny-binary advantage
  and requires one runtime per target architecture.
- Native packaging requires Rust/Cargo and the pinned Tauri CLI. Routine
  `bun run dev` remains unchanged.
- Ad-hoc signing is reproducible but not a distributable identity. Developer ID,
  hardened-runtime validation, notarization, stapling, and Gatekeeper testing
  remain release work.
- The control endpoint is opt-in and loopback-only. A future production
  diagnostic endpoint would need authentication and a product contract.
- Menus expose lifecycle actions and Open Diagnostic Logs. Continuous service
  transition, provider connectivity, and failure details are displayed in the
  desktop dashboard rather than duplicated in static menu labels.
