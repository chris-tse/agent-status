# Implementation Progress

## 2026-07-22 23:50 CDT - #1 (Service endpoint identity in /health)

- Added application identity (`service`) and `protocolVersion` to the `GET /health`
  response alongside its existing `status`, snapshot `version`, and `provider`
  fields, so a probe can distinguish three situations from the payload alone: a
  compatible service, the expected service speaking an incompatible protocol, and
  an unrelated process squatting on the endpoint.
- Extracted the HTTP routing out of `Bun.serve`'s inline `fetch` into an exported
  `handleStatusRequest(request, context)` function (`RequestContext` carries the
  store/provider/demo/clock plus an optional `upgrade` callback). `Bun.serve` now
  delegates to it, passing `upgrade` for the `/ws` WebSocket handshake.
- Coverage is through the public HTTP interface via real `Request`/`Response`
  objects (identity present, legacy fields intact, three-way distinguishability).
- Files changed:
  - `packages/model/src/index.ts` — `SERVICE_NAME`, `PROTOCOL_VERSION`,
    `HealthResponseSchema`/`HealthResponse`.
  - `apps/service/src/server.ts` — `handleStatusRequest` + `RequestContext`;
    `/health` identity fields; `Bun.serve` delegates to the handler.
  - `apps/service/src/index.ts` — re-export `handleStatusRequest`/`RequestContext`.
  - `apps/service/test/server.test.ts` — new HTTP-interface tests.
  - `README.md` — updated `/health` documentation.
- **Learnings for future iterations:**
  - **The shared HTTP/WS contract lives in `@status-dashboard/model`.** Constants
    like `SERVICE_NAME` and `PROTOCOL_VERSION`, plus wire schemas, belong there so
    the service and every consumer (dashboard, Stream Deck, future desktop
    controls) import one source of truth rather than duplicating literals.
  - **Gotcha: `@status-dashboard/model` resolves to a prebuilt `dist/` (git-ignored),
    not `src/`.** After editing the model's `src`, you must rebuild
    (`bun run --filter '@status-dashboard/model' build`) before the service or its
    tests see the new exports — otherwise imports resolve to stale `undefined`
    values with confusing runtime errors. The repo-wide `bun run build` also does
    this; the `dist/` is not committed.
  - **Tests run under vitest on Node, where the `Bun` global is undefined.** So
    `Bun.serve` cannot be started inside a test. The pattern is to keep routing in
    a pure `handleStatusRequest(request, context)` function that takes real
    `Request` objects and returns real `Response` objects; `Bun.serve`'s `fetch`
    is a thin adapter. WebSocket upgrade is injected via a `context.upgrade`
    callback so the router itself stays socket-free and testable.
  - **No consumer currently parses `/health`** (dashboard and Stream Deck use `/ws`
    and `/api/snapshot`), so adding fields is purely additive and safe; keep the
    legacy fields (`status`, `version`, `provider`) to avoid breaking anything.
  - **Don't confuse the two "version" fields:** `version` in health/snapshots is a
    monotonic store/state counter, while `protocolVersion` is the wire-contract
    compatibility version. They are independent.
  - **Repo commands:** `bun run typecheck` (all workspaces + scripts),
    `bun run test` (full suite), `bun run --filter '@status-dashboard/service' test`
    (single package). Tests that bind sockets (e.g. the Herdr unix-socket test) may
    hit `EPERM` inside a restricted sandbox — run them without sandbox restrictions.

---

## 2026-07-23 00:04 CDT - #2

- Added an assembled-service acceptance harness that launches the service in a
  Bun subprocess with an injected deterministic provider and clock, then drives
  it through real loopback HTTP and WebSocket connections.
- Covered initial snapshots, sequential and stale updates, reconnect recovery,
  all provider connectivity transitions, health endpoint identity, graceful
  shutdown, and abnormal provider failure using only process and wire-visible
  assertions.
- Files changed:
  - `apps/service/test/acceptance.test.ts` — end-to-end acceptance scenarios.
  - `apps/service/test/support/acceptance-harness.ts` — reusable subprocess,
    HTTP/WebSocket, provider-control, clock-control, and lifecycle harness.
  - `apps/service/test/fixtures/acceptance-service.ts` — Bun service assembly
    with the controlled provider and clock.
  - `docs/progress.md` — implementation notes and test guidance.
- **Learnings for future iterations:**
  - Vitest runs in Node, so real `Bun.serve` acceptance tests must spawn a Bun
    subprocess; the fixture binds port `0` and reports Bun's selected loopback
    URL to avoid fixed-port collisions.
  - Provider and clock controls travel over the child process's stdin, with
    acknowledgements on stdout so a returned control promise means the assembled
    service has applied the command before the next HTTP or WebSocket action.
  - Run the focused seam with
    `bun run --filter '@status-dashboard/service' test -- test/acceptance.test.ts`;
    it remains part of the normal repository-wide `bun run test`.
  - Graceful stop closes WebSockets with code `1000` and exits with code `0`;
    the controlled abnormal-failure command throws from the provider and yields
    an unclean socket close plus process exit code `1`.

---

## 2026-07-23 00:50 - Tooling sidebar (oxlint + oxfmt)

- Installed `oxlint` and `oxfmt` as root dev dependencies and made them the
  pre-commit gate: a checked-in `.githooks/pre-commit` lints and format-checks
  staged files, activated via `core.hooksPath` set by the root `prepare`
  script on `bun install`. One repo-wide `oxfmt` pass reformatted 51 files so
  the check passes from now on.
- Files changed: `package.json` (deps + `lint`/`format`/`format:check`/`prepare`
  scripts), `.oxlintrc.json`, `.oxfmtrc.json`, `.githooks/pre-commit`,
  `bun.lock`, plus mechanical formatting across the repo.
- **Learnings for future iterations:**
  - Run `bun run lint` and `bun run format` before committing; the pre-commit
    hook rejects unformatted or lint-erroring staged files (warnings don't
    block, errors do).
  - The generated Stream Deck bundle
    `apps/stream-deck/com.status-dashboard.stream-deck.sdPlugin/**` is excluded
    via `ignorePatterns` in both `.oxlintrc.json` and `.oxfmtrc.json` — keep
    generated artifacts out of lint/format scope the same way.
  - Both tools exit non-zero when every file passed to them is ignored; the
    hook passes `--no-error-on-unmatched-pattern` to avoid spurious failures.
  - oxfmt formats JSON/JSONC too, and its style prefers explicit parens and
    sorted formatting; don't hand-fight it — run `bun run format`.
  - `bun add` writes explicit registry tarball URLs into `bun.lock` when a
    non-default registry is active (e.g. via `BUN_CONFIG_REGISTRY`); install
    against the default registry so the lockfile stays registry-agnostic.

---
