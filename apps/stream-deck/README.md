# Status Dashboard Stream Deck prototype

This Stream Deck plugin targets Elgato's Node 24 host and is built with the official
`@elgato/streamdeck` 2.x SDK. Its manifest uses protocol `SDKVersion: 3`, as
required by the current SDK scaffold for Stream Deck 7.1+, while the JavaScript
SDK package remains 2.x.

## Agent Slot

Action UUID: `com.status-dashboard.stream-deck.agent-slot`

Place Agent Slot on as many keypad keys as desired. Visible instances form one
slot pool:

- Selected Agent Slot keys are ordered left to right, then top to bottom; keys
  assigned to other actions do not affect that order.
- Once the visible Agent Slot layout is stable, an assigned resource remains on
  its key until the service removes it or that key is no longer visible.
- Vacancies select waiting/failed agents first, then running agents, then the
  most recently completed agents.
- Status changes update color and text without moving an existing assignment.
- The key shows running blue, waiting amber, completed green, failed red, plus
  connecting, offline, and connected-empty states.
- Pressing a key sends `POST /api/demo/advance` to the configured service
  origin for prototype validation.

The plugin defaults to `ws://127.0.0.1:4317/ws`. It also listens for an
`endpoint` string in Stream Deck plugin global settings. Only loopback
`ws://`/`wss://` URLs are accepted; invalid values fall back to the default.
There is intentionally no property inspector in this smallest prototype, so a
future inspector or another plugin-side settings writer must set that global
value.

Incoming JSON is validated with `DashboardWireMessageSchema` from
`@status-dashboard/model`. Snapshots replace local state, sequential updates
are applied transactionally, stale updates are ignored, and version gaps force
a reconnect to obtain a fresh snapshot.

## Bun workflow

Install all workspace dependencies once from the repository root:

```sh
bun install
```

Then run these exact commands:

```sh
cd apps/stream-deck
bun run test
bun run typecheck
bun run build
bun run validate
bun run link
bun run restart
```

For rebuild-and-restart development after linking:

```sh
cd apps/stream-deck
bun run dev
```

To create an installable bundle:

```sh
cd apps/stream-deck
bun run pack
```

The CLI scripts use `bunx @elgato/cli`; no global CLI installation is needed.
Validation does not require the Stream Deck desktop app. Linking, restarting,
and live key testing do. Before linking a development plugin for the first
time, enable developer mode with:

```sh
bunx @elgato/cli dev
```

The checked-in category/action assets are SVG in the dimensions accepted by
the manifest schema. Stream Deck requires the top-level marketplace icon to be
PNG, so valid 256 px and 512 px placeholder PNGs are included. Replace those
plain placeholders with branded artwork before distribution.
