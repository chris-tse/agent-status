# Ambient Status Dashboard

## Document purpose

This product brief defines the long-term intent and boundaries of the Ambient
Status Dashboard. It describes why the product exists and what it should
become; implementation details and provider-specific behavior belong in
separate technical specifications.

## Vision

Build a local status aggregation service that provides ambient awareness across
the tools used throughout the day.

The goal is not another launcher or a dashboard full of controls. It should
answer one question:

> What needs my attention right now?

As the workflow shifts toward supervising multiple AI agents rather than
continuously writing code, more time is spent checking applications to learn
whether work has completed, become blocked, or requires input. The Ambient
Status Dashboard becomes the single place to see that information.

## Core responsibilities

The product has three responsibilities:

1. Collect status from many applications.
2. Normalize that information into a common model.
3. Present it across multiple output surfaces.

The system must not become tightly coupled to any single application. Herdr is
the first planned integration, not the architecture.

## Architecture

```text
                   Applications
      ┌─────────────┼──────────────┬──────────────┐
      │             │              │              │
   Herdr         Cursor         GitHub         Slack
 (Socket API) (Hooks/API)       (API)         (Future)
      │             │              │              │
      └─────────────┼──────────────┘
                    ▼
           Provider integrations
                    ▼
        Unified status and event model
                    ▼
      Ambient Status Dashboard service
          │            │             │
          ▼            ▼             ▼
 Desktop dashboard  Stream Deck  Notifications
```

Every output consumes dashboard state. Providers never communicate directly
with presentation surfaces or with one another.

The local service has a lifecycle independent of every presentation surface.
Closing one surface must not interrupt status delivery to another.

## Provider model

Each source application is represented by a provider. A provider is responsible
for:

- connecting to its application;
- receiving state and lifecycle events;
- maintaining local integration state when necessary;
- translating application-specific concepts into the shared model.

Providers do not know how their state is presented.

### Herdr

Herdr is the first intended real provider. Its available concepts include:

- workspaces;
- tabs and panes;
- active agents;
- agent lifecycle;
- custom status;
- event subscriptions.

The initial Herdr integration should contribute workspace and agent resources
plus their lifecycle events.

### Cursor

Cursor is an investigation target. Potential integration points include hooks,
the Background Agent API, and future plugin APIs.

Its initial value is lifecycle state, background-agent state, and completion or
input notifications. Richer runtime state can be added without changing
consumers.

### Future providers

Likely future providers include:

- GitHub;
- Slack;
- email;
- Docker;
- CI/CD systems;
- local development servers;
- Kubernetes;
- browser automation.

Adding a provider should not require changes to presentation code.

## Unified model

The dashboard distinguishes two categories of information.

### Stateful resources

Long-lived entities that remain present until updated or removed, such as:

- workspaces;
- running agents;
- background tasks;
- provider connectivity.

### Events

Short-lived facts that may expire or be acknowledged, such as:

- a build failure;
- a review request;
- an agent completing;
- an agent waiting for input.

The attention policy—priority, acknowledgement, expiry, and deduplication—will
be refined through use rather than fixed before the first working integration.

## Output surfaces

### Desktop dashboard

The desktop surface provides richer workstation context, including:

- active workspaces;
- running agents;
- recent events;
- queue health;
- provider connectivity;
- elapsed runtimes.

The browser-based prototype validates this experience before choosing the final
desktop shell.

### Stream Deck

The Stream Deck is a first-class ambient display, not merely a macro pad.
Physical keys should communicate status at a glance without requiring
interaction.

#### Dynamic agent slots

The dashboard exposes a fixed pool of agent slots:

- assign a new agent to the next available slot;
- retain that assignment while the agent exists;
- update its visual status continuously;
- release the slot when the resource is removed;
- avoid unnecessary key reordering.

#### Visual language

Keys are small, so appearance should rely primarily on provider identity,
background color, and restrained motion rather than text.

| State     | Appearance                                          |
| --------- | --------------------------------------------------- |
| Running   | Provider logo, blue background, optional slow pulse |
| Waiting   | Provider logo, amber background                     |
| Completed | Provider logo, green background                     |
| Failed    | Provider logo, red background                       |

Short labels are optional. Recognition should not depend on reading.

#### Interaction

Button actions are secondary. Possible actions include:

- focusing a Herdr workspace;
- opening Cursor;
- jumping to a GitHub review;
- acknowledging a notification.

## Technology direction

- TypeScript
- Bun for package management, scripts, and the local service runtime
- React for the dashboard
- Browser-first prototype, with Tauri preferred for a later desktop shell
- Official Elgato Stream Deck SDK plugin
- Local HTTP, IPC, or WebSocket communication
- Event-driven integrations wherever source APIs support them

## Future hardware

The Stream Deck is the first hardware target. Future consumers may include:

- RGB indicators;
- QMK or ZMK devices;
- custom ESP32 displays;
- menu-bar widgets;
- mobile companion applications.

Hardware integrations consume dashboard state and never connect directly to
providers.

## Success criteria

The product succeeds when:

- the dashboard or Stream Deck becomes an instinctive ambient glance;
- manually checking multiple applications becomes unnecessary;
- agent completion and requests for input are visible without interrupting
  current work;
- new providers can be added with minimal effort;
- the Stream Deck functions as an information display rather than only a
  programmable keyboard.

## Current validation milestone

The first prototype uses a simulated provider to validate the complete path:

```text
Provider → normalized model → local service → dashboard and Stream Deck
```

Once that path is reliable on real hardware, the simulator can be replaced or
supplemented by the first Herdr provider without changing either presentation
surface.
