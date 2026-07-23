# Status Dashboard

A local prototype that turns provider-neutral agent status into a browser
dashboard and stable Stream Deck key assignments.

See [`docs/product-brief.md`](docs/product-brief.md) for the product vision,
scope, and long-term architecture.

## Architecture

- `packages/model` defines the Zod-validated snapshot, update, reset, provider,
  resource, and event contracts shared over HTTP and WebSocket.
- `apps/service` is a Bun HTTP/WebSocket service. It can use either the
  deterministic demo provider or a live Herdr socket provider.
- `apps/dashboard` is a React/Vite client. It loads an initial snapshot, applies
  sequential WebSocket updates, and refetches after reset or a version gap.
- `apps/stream-deck` is an Elgato SDK plugin. Visible Agent Slot actions form a
  stable priority pool and consume the same validated wire messages.

All workspace dependency links use Bun workspaces and
`@status-dashboard/model`.

## Requirements

- Bun 1.3.14 for installing dependencies and running every repository script.
- Node.js 24 is only the Stream Deck plugin runtime compatibility target because
  the Stream Deck desktop app hosts plugins in Node. It is not the repository
  package manager or script runner.

## Install and run

Run all commands from the repository root:

```sh
bun install
bun run dev
```

`bun run dev` starts both processes and stops both on Ctrl-C or SIGTERM:

- Dashboard: http://127.0.0.1:4173
- Status service: http://127.0.0.1:4317
- WebSocket feed: ws://127.0.0.1:4317/ws

To run one side only:

```sh
bun run dev:service
bun run dev:dashboard
```

## Service lifecycle

On macOS, manage the production-shaped background service from the terminal:

```sh
bun run service status
bun run service start
bun run service stop
bun run service restart
```

Start bootstraps a launchd job into the current `gui/<uid>` login session.
launchd restarts the active service after an abnormal exit, while an explicit
stop unloads the job. The generated plist is stored below
`~/Library/Application Support/Ambient Status Dashboard/launchd`, not
`~/Library/LaunchAgents`, so it is not a login item and is not activated in the
next login session. A compatible service already using the endpoint is reused;
an unrelated or protocol-incompatible listener produces an error and is never
terminated.

Set `PORT` or `HOST` to change the service listener. `CORS_ORIGINS` accepts a
comma-separated allowlist; without it, browser origins on loopback hosts are
allowed. Set `VITE_STATUS_SERVICE_URL` when the dashboard should connect to a
service other than `http://127.0.0.1:4317`.

## Release measurements

Measure every production desktop runtime with the same macOS protocol:

```sh
bun run measure:release --config docs/measurements/configs/<runtime>.json
```

The command records a versioned JSON result and regenerates a side-by-side
comparison covering compressed and installed size, open/closed resident memory,
idle CPU and wakeups, startup and reconnect latency, and developer build/reload
time. See [the release measurement protocol](docs/measurements/protocol.md) for
the required runtime adapter commands and sampling rules.

## Electrobun runtime spike

The production-shaped Electrobun spike packages the real React dashboard and
Bun status service into a native macOS application. It uses Herdr by default
and provides dashboard and service lifecycle controls in both the menu bar and
application menu.

```sh
bun run --filter '@status-dashboard/electrobun' dev
bun run --filter '@status-dashboard/electrobun' build:release
bun run measure:release --config docs/measurements/configs/electrobun.json
```

See [the Electrobun spike findings](docs/spikes/electrobun.md) for Close and
Quit semantics, the measured stable build, packaging workflow, and known
limitations.

The demo provider remains the default. To read live agents from the default
Herdr session:

```sh
STATUS_PROVIDER=herdr bun run dev
```

The provider follows Herdr's socket selection environment variables:
`HERDR_SOCKET_PATH` overrides the path directly, while `HERDR_SESSION` selects
a named session below the Herdr config directory. It validates Herdr's
newline-delimited JSON, bootstraps from `session.snapshot`, subscribes to
lifecycle and agent-status events, reconnects after failures, and normalizes
Herdr agent states without exposing provider-specific concepts to consumers.

Herdr's upstream repository can be cloned into the ignored `vendor/herdr`
directory when its implementation or generated protocol schema is useful as a
local reference.

## Service API and demo

- `GET /health` returns application identity (`service`), protocol version
  (`protocolVersion`), provider, and snapshot-version status, so a probe can
  tell a compatible service from one speaking an incompatible protocol or an
  unrelated process on the endpoint.
- `GET /api/snapshot` returns the current validated dashboard snapshot.
- `GET /ws` upgrades to the WebSocket feed and immediately sends a snapshot.
- `POST /api/demo/advance` moves the live demo agent through waiting, running,
  completed, failed, and retry states.
- `POST /api/demo/reset` restores the seeded demo snapshot.

The dashboard header has **Advance** and **Reset** controls for those routes
when the demo provider is active. With the Herdr provider selected, demo
requests return `409`. Pressing a visible Stream Deck Agent Slot still invokes
the demo route, so live Herdr keys currently act as status displays only.

## Verify and build

```sh
bun run test
bun run typecheck
bun run build
```

The dashboard production output is written to `apps/dashboard/dist`. Serve it
locally after building with:

```sh
bun run preview:dashboard
```

## Stream Deck workflow

The plugin defaults to `ws://127.0.0.1:4317/ws` and accepts only loopback
`ws://` or `wss://` endpoints from global plugin settings.

Build and validate the plugin bundle:

```sh
bun run --filter '@status-dashboard/stream-deck' build
bun run stream-deck:validate
```

With the Stream Deck desktop app installed, link and restart the plugin:

```sh
bun run stream-deck:link
bun run stream-deck:restart
```

After linking, rebuild and restart on source changes with:

```sh
bun run --filter '@status-dashboard/stream-deck' dev
```

Create an installable plugin bundle with:

```sh
bun run --filter '@status-dashboard/stream-deck' pack
```

CLI validation can run without hardware. Live plugin and key behavior testing
requires the Stream Deck desktop app and hardware (or an app-supported virtual
device). Enable developer mode with `bunx @elgato/cli dev` before linking a
development plugin for the first time.
