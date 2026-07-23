# Release Measurement Protocol

Use this protocol for every production-shaped desktop runtime spike. It applies
the same macOS measurements and result schema to each candidate; advertised
framework or bundle sizes are not inputs.

## One-command measurement

Copy `config.example.json` to a runtime-specific, checked-in configuration,
replace every placeholder, build or obtain the release artifact, and run:

```sh
bun run measure:release --config docs/measurements/configs/<runtime>.json
```

The command writes a versioned JSON record under
`docs/measurements/results/` and regenerates `comparison.md` from all records
in that directory. Commit the runtime configuration, JSON record, and comparison
table together. Do not commit the release artifact or expanded application.

Use `--output <path>` and `--comparison <path>` only for an isolated trial. A
normal recorded run uses the defaults so all candidates remain side by side.

## Required configuration

Paths are resolved relative to the configuration file. Commands run through
non-login `/bin/zsh -c` shells from `workingDirectory`, which is also relative
to the configuration file. The runner inherits its environment from the
invoking terminal; it does not load user login profiles into every measured
operation because their startup work would contaminate timings and make results
machine-specific.

- `runtime` is the candidate name and `buildId` identifies the measured release.
- `release.distributionPath` is the final compressed release file, such as a
  signed DMG or ZIP. Its exact file length is the compressed distribution size.
- `release.installedPath` is the expanded installed `.app` directory. Its
  allocated size from `du -sk` is the installed size.
- `developerBuild` performs and waits for one normal developer build.
- `developerReload` triggers and waits for one normal developer reload. Include
  watcher startup and teardown in the command if the spike needs them, but make
  the measured operation explicit and repeat it the same way for every runtime.
- `launch` starts the release with its dashboard open and returns once launch
  has been requested. `waitForDashboard` blocks until the production dashboard
  is usable. Their combined wall time is startup time.
- `processIds` prints every PID owned by the measured product, separated by
  whitespace. With the dashboard open this includes its renderer; after Close
  it excludes a destroyed renderer but still includes the independently running
  service and other surviving runtime processes.
- `closeDashboard` closes the presentation and waits until the renderer has
  been destroyed. `openDashboard` opens it again.
- `triggerReconnect` interrupts the live service connection and returns as soon
  as the interruption has been triggered. `waitForReconnect` blocks until the
  reopened dashboard has recovered a current snapshot. Their combined wall time
  is reconnect time.
- `stop` performs complete cleanup and must be safe after all successful
  measurements. It also runs when a later measurement step fails.

Every command is required. The runner rejects an incomplete configuration
instead of omitting a measure or substituting one metric for another.

## Resource sampling

The default protocol waits 15 seconds for each idle state, then asks macOS
`top` for 10 one-second delta samples of all product PIDs. The first sample is
discarded because macOS documents its CPU value as invalid. For each remaining
interval the runner:

1. sums resident size, CPU percentage, and idle wakeup deltas across all
   configured product PIDs;
2. averages the aggregate resident size and CPU percentage across intervals;
3. divides the aggregate idle-wakeup count by elapsed sample seconds.

This yields distinct measurements for resident memory, CPU, and wakeups with
the dashboard open and closed. The `POWER` score is deliberately not collected:
it would be a proxy, not any of the required measures.

Run candidates on the same otherwise-idle Mac, power source, display setup, and
OS version. Keep `sampling` identical unless a result explicitly documents why
it differs. The JSON record captures sampling parameters, host details,
repository commit/dirty state, configuration path, and configuration hash so a
comparison can identify environmental drift.

## Result fields and units

All records use `schemaVersion: 1` and preserve the measures independently:

| JSON field                                 | Unit and meaning                                        |
| ------------------------------------------ | ------------------------------------------------------- |
| `sizes.compressedDistributionBytes`        | Exact bytes in the compressed release file              |
| `sizes.installedBytes`                     | Allocated bytes in the expanded installed application   |
| `idle.dashboardOpen.residentMemoryBytes`   | Mean aggregate resident bytes, dashboard open           |
| `idle.dashboardClosed.residentMemoryBytes` | Mean aggregate resident bytes, dashboard closed         |
| `idle.*.cpuPercent`                        | Mean aggregate process CPU percentage                   |
| `idle.*.wakeupsPerSecond`                  | Aggregate macOS `IDLEW` deltas per sample second        |
| `timings.startupMilliseconds`              | `launch` through successful dashboard readiness         |
| `timings.reconnectMilliseconds`            | reconnect trigger through recovered dashboard readiness |
| `timings.developerBuildMilliseconds`       | Wall time of the configured developer build             |
| `timings.developerReloadMilliseconds`      | Wall time of the configured developer reload            |

The comparison table converts byte values to MiB only for display. The JSON
records remain the source of truth.
