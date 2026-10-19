# Crash and abnormal-exit attribution (OPEND-3716)

This additive definition accompanies `stability-metrics.md`. It implements local
observation, not product acceptance or an explanation of the reported historical
99.9% unknown / approximately 104,000 events across 12,000 installations. No
production data was queried for this change. Historical events are not relabeled.

## Exit classification

Existing `desktop_renderer_crash`, `desktop_child_process_crash`,
`desktop_unclean_exit`, `daemon_unclean_exit`, and `packaged_runtime_failed`
remain compatibility carriers. Native renderer `reason` and daemon `exit_class`
retain their meanings; `exit_reason` is additive where necessary. A new
`client_process_exit` event is a controlled projection through the shared
`buildClientTelemetryParams` / `parseClientMetricEvent` schema, using
`event_schema_version=4`, `metric_schema_version=1`.

| Normalized reason | Evidence and treatment |
| --- | --- |
| `crash` | Electron `crashed`/`abnormal-exit`, Node fatal report, or observed nonzero exit; not inferred from memory pressure |
| `oom` | Electron explicitly says OOM, or prior-session fatal report / bounded prior log contains OOM evidence |
| `killed` | An observer actually receives a killed reason or SIGKILL/SIGTERM during packaged startup; separate from crashes |
| `clean-exit` | Electron clean exit, observed zero daemon exit, completed graceful shutdown, or recorded OS shutdown/logoff/session end |
| `recovery-attempt` | Existing cooldown retry signal; excluded from crash counts |
| `unknown` | Missing completion marker without stronger evidence; includes silent force-kill/power loss, never automatically OOM |

An unfinished quit remains unknown: merely requesting quit is not proof of
successful teardown. Suspend alone is not proof of termination. Graceful daemon
shutdown (including updater sidecar retirement) still writes the clean marker;
a zero daemon exit that bypasses cleanup now produces a clean health summary instead
of `daemon_unclean_exit`. There is no attempt to infer a shutdown/update from a
missing marker. A SIGKILL cannot run an exit listener, so daemon restart reports
unknown even when a test harness knows it killed the child.

The renderer breaker still parks after five deaths within 60 seconds. The
opening event carries `recovery_suppressed=true`; later repeated death reports
are suppressed. A quiet five-minute cooldown emits `reason=recovery-attempt`
before one reload. Killed renderers can require recovery without counting as
crashes. Clean exits do not feed the breaker. These flags do not estimate how
many suppressed crashes occurred.

## Replay, lifecycle and attribution

Desktop markers now retain the original launch attempt, session, active payload
version, observed main exit code (when available), and last observation time.
The main exit listener marks zero exits clean and preserves nonzero evidence;
silent native crashes or kills cannot run that listener. Main/renderer/child events use the same
launch IDs as startup metrics. Packaged main passes its original IDs in
`OD_APP_SESSION_ID` / `OD_LAUNCH_ATTEMPT_ID` to the daemon before spawning it;
these are observation context, not sidecar identity or user identity. The
telemetry route can bind the first valid desktop launch context in development.
A deferred headless window restore has no launch denominator and uses null.

Replay preserves `previous_app_version`, occurrence `app_version`,
`app_session_id`, and `launch_attempt_id`. The reporting version does not replace
the previous version, including when the latter is unknown (null). Channel is
derived from the occurrence version. Old markers have nullable association;
they cannot acquire the new launch's IDs or qualify for a linked crash rate.

A desktop missing-marker observation has no exact death timestamp. `occurred_at`
is the last recorded running observation (or legacy start), qualified by
`occurrence_time_source=last_checkpoint` (or `unknown`). Daemon checkpoint time
is similarly a last-known-alive bound; it can lag death by more than 60 seconds
when the process is blocked. `reported_at` is the upload time. Do not treat these
bounds as exact crash timestamps or use them unqualified for fine time cohorts.

Desktop replay IDs are stable hashes of original session IDs; queues deduplicate
sessions. Daemon replay retains the original boot insert ID and deduplicates
pending reports. The normalized projection uses the carrier ID plus `:exit`.
Successful local enqueue acknowledgements clear individual daemon pending
reports immediately; rejected sends remain pending. Remote delivery is best
effort, not exactly-once: interrupted acknowledgement can replay the same ID,
and backend queries must deduplicate `event_id` / `$insert_id`.

Only a checkpoint rotated from the current file is eligible for daemon replay.
When current is absent, an old previous file is not resurrected. This removes a
verified local path that could repeatedly report the same old unknown exit;
it does not prove how much of the historical production volume it explains.
Queues remain bounded to 20 desktop sessions and five daemon reports. Erased,
unwritable, or corrupt markers can lose evidence; there is no reconstructed rate.

## Denominators and safety delivery

Compute crash-session rate as distinct `(device_id, app_session_id)` with
normalized reason in `{crash, oom}` divided by distinct matching sessions with a
real `client_launch_attempt`, within the same version/channel/platform and
safety capture domain. A session with multiple renderer crashes contributes
once. Crash-attempt rate uses distinct `(device_id, launch_attempt_id)` over
real matching attempts instead. Startup failure rate joins failed
`client_launch_result` to attempts; `packaged_runtime_failed` is diagnostic
support and is not automatically a proven process crash.

Exclude clean exits, recovery attempts and killed events from the crash
numerator; publish unknown/killed separately. Missing identity, missing launch
association, legacy-only data, and a zero/missing denominator mean
**not calculable**. Never divide raw exit counts by installations or call that a
user rate. `device_id` is an installation, not an account or person. The legacy
synthetic packaged identity is null in the new metric and is ineligible.

稳定性埋点沿用安全通道，不受匿名指标开关控制（`telemetry.metrics`）。
This includes launch, memory, normalized exit events, legacy exit carriers and
`packaged_runtime_failed`. There is no desktop, ingestion, service or packaged
consent lookup for these events. Existing key/environment gates remain.
The new exit schema strips paths, URLs, content, prompts, raw PIDs and diagnostic
text. Existing scrubbed diagnostic payload fields retain their historical
compatibility semantics; this change adds none to the new metric.

## Memory P2 and overhead

`sampler.stop()` aborts in-flight HTTP and cancels remaining batch sends.
An already received event cannot be recalled. No consent fetch is needed.

Packaged main records Electron ready before sidecar boot and passes that
monotonic timestamp to desktop. First delay is `max(0, 30000 - elapsedSinceReady)`;
20 seconds of boot leaves 10 seconds, not 30. If registration occurs after the
30-second deadline, sample as soon as registered rather than fabricate a past
sample. Event-loop scheduling can delay actual collection. Subsequent cadence
remains 60 seconds, with no overlapping batches and at most 64 native entries.
Collection/transport CPU remains subject to the existing <1% budget; it has not
been reprofiled across native platforms in this task.

Exit processing adds one schema projection per accepted carrier, no polling.
Desktop HTTP remains bounded by five seconds. Packaged
legacy and normalized exit sends run together under their existing five-second
network cap, without adding a second sequential network wait. No startup success
path awaits telemetry delivery. Filesystem scheduling is outside network caps.

## Validation and remaining QA

Local tests inject real Node child zero/nonzero exit and SIGKILL/restart against
real checkpoint files; fixtures cover fatal OOM evidence, graceful shutdown,
stale-previous replay, failed acknowledgement, upgrades and null metadata.
Renderer handler tests exercise teardown, clean/killed/OOM/recovery reasons and
breaker suppression. HTTP/service tests check safety delivery after opt-out, projection and dedup IDs.
Packaged failure tests inject daemon/web startup failures and inspect captured
payloads; they do not launch a signed packaged application.

QA must run signed macOS and Windows candidates with isolated runtime data:

1. Opt in, launch cold/warm, record launch attempt/session/version. Inject a
   daemon startup failure and then a web startup failure using disposable
   candidates; verify one failed launch result per attempt and matching exit IDs.
2. Crash the main-window renderer (DevTools/native debug crash). Verify recovery,
   crash reason and shared IDs. Repeat five times within a minute: the fifth
   event is flagged suppressed, later deaths do not flood telemetry, and after
   five quiet minutes a recovery-attempt is excluded from the crash numerator.
3. Exit via Quit and updater restart; then log off/shut down the OS. Relaunch and
   verify expected shutdowns do not appear as crash/OOM. Force-kill main and
   daemon separately, relaunch, and verify unknown without evidence, original
   version/session/attempt, and stable replay ID when delivery was interrupted.
4. Upgrade between the killed session and restart. Confirm attribution remains
   on the killed version and legacy missing IDs remain null. Repeat with network
   disabled, reconnect/restart, and deduplicate by the original event ID.
5. Delay daemon/web boot by 20 seconds: observe first memory sample near ready+30
   seconds plus scheduling latency. Delay >30 seconds: sample promptly at sampler
   registration. Quit during held delivery and verify abort/no further sample.
6. Opt out, corrupt a previously saved config, and deny config reads separately.
   Repeat crash/restart and memory cases; verify safety events still report and
   normalized payloads contain no paths, URLs, content, prompts or raw PIDs.
   Confirm a product analytics event remains blocked.

Native main crashes, OS-specific shutdown/update behavior, real ingestion,
signed-platform QA, release, and seven-day before/after observation remain open.
The task does not establish that production crash rate or memory budget improved.
