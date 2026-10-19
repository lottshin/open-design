# Responsiveness telemetry (OPEND-3720)

This is an implementation candidate based on `aa88f4387`, not ticket acceptance,
a deployment, or proof of an improvement. The scope is observation, not a fix
for the underlying rendering stalls. The common envelope and original stability
metrics remain defined in [stability-metrics.md](./stability-metrics.md).

## Integration status

Two protected-file changes still require the dispatcher's scope authorization:

- Register the four new schemas in `client-metrics.ts`. Until registration, new
  names fall through the old transport instead of `parseClientMetricEvent`;
  they must not be released in this state. The schema-admission regression is
  intentionally red and the additive fields are ready in
  `client-observability.ts`.
- Add a send-time consent predicate to `error-tracking.ts` and pass it from the
  responsiveness gate. This must also fence a revoked grant across a later
  re-grant, so previously buffered metrics cannot reappear. The regression for
  delayed transport initialization is intentionally red.

The external delivery logs contain a reviewable, unapplied patch for those
changes. Other production callers retain their existing behavior. This candidate
is blocked on integration, not ready for publication.

## Consent and privacy

Observers start only after the UI metrics decision is granted AND a fresh
`/api/analytics/config` read returns `enabled=true`. That endpoint uses the
strict daemon `readMetricsConsent` path; a general config fallback cannot grant
collection. A failed read, malformed response, explicit denial, or a three-second
timeout leaves collection disabled. The live UI toggle disables immediately;
a stale in-flight response cannot grant again. There is one extra bounded config
request per grant, not one per interaction. Observer setup and all reads are
asynchronous with respect to startup readiness.

The gate covers long tasks, input latency, scroll-frame summaries, the existing
chat-freeze event and chat-health reports. Local scroll diagnostics and recovery
continue operating independently. No DOM value, key text, selector, path, URL,
prompt, attribution container name or raw PID is reported. The old long-task
attribution fields are omitted. Fixed DOM markers are read for classification
only; their strings are never transmitted. The shared envelope supplies
installation/session/platform/version metadata, using null for unavailable
values. `device_id` identifies an installation, never an account.

The old safety transport's early buffer is the remaining consent blocker noted
above. Events whose HTTP send has already started cannot be recalled.

## Long tasks and qualified exposure

`client_long_task` retains its duration/start-time meaning for every observed
foreground task with `duration_ms >= 5000`, including exactly 5000. It is emitted
immediately, without a session cap. Occurrence time is the task start, not the
subsequent flush time. No per-small-task network request or attribution scan
remains. Tasks in the 100–4999ms range are counted in constant space.

`client_responsiveness_window`, `measurement=long_task`, reports every 30 seconds,
including clean windows with zero counts. Its fields are:

- `long_task_count`: tasks >=100ms, including severe tasks;
- `severe_task_count`: tasks >=5000ms;
- `max_duration_ms`: maximum observed duration, or null when no task occurred;
- `window_ms`: measured eligible foreground exposure;
- `measurable`, `telemetry_capability`, `unavailable_reason`: denominator gates.

Eligibility requires a successfully installed Long Tasks observer and an
uninterrupted foreground interval. A hidden interval, hide/reveal between ticks,
wall/monotonic disagreement >=1000ms, or delayed tick >35 seconds makes the
window unmeasurable. Its counts and duration are null, not fake zeros. Unsupported
API and an observer that throws are reported as unsupported. Entries predating
consent/reveal are excluded; observation is deliberately unbuffered.

`measurement=event_timing` has its own support/foreground heartbeat. Support for
one API never implies support for the other. Qualified exposure is renewed each
window; an initial grant alone is not an active-session denominator. Session
identity comes from the common transport envelope; null session IDs cannot be
used to manufacture session counts.

A session-day can be counted only with a measurable heartbeat for the relevant
API. Daily aggregation must use occurrence time and the chosen reporting time
zone, splitting the `[occurred_at-window_ms, occurred_at]` exposure interval at
midnight when necessary. For the severe-stall KPI, intersect the numerator with
the same eligible session/account-day cohort and deduplicate account-day, not
event count. A severe event and its recovery summary must never both contribute
to that numerator.

## Recovery and what a renderer cannot prove

A single bounded local checkpoint stores an opaque recovery ID, timestamp,
maximum observed severe duration and severe-task count. There is at most one
ordinary storage write per 30-second foreground window, plus a write for each
severe task before attempting its network report. No task list grows over time.
Storage denial/corruption cannot interrupt the application. Opt-out discards the
active checkpoint. Backgrounding and normal page exit clear unknown markers; an already observed
severe checkpoint survives them for best-effort recovery.

On the next consented collector start, `client_responsiveness_recovery` reports:

- `observed_severe_task`: callback ran and persisted a >=5s task before a possible
  failed send; original timestamp, maximum duration and count are preserved;
- `unclean_exit_unknown`: only an unfinished foreground marker survived;
  duration is null and this is **not** proof of a >=5s stall.

Recovery is best effort and diagnostic. The current transport has no receipt
acknowledgment, so an observed-severe summary may duplicate a successfully sent
live event. Do not add recovery counts to live counts. The one origin-local
checkpoint cannot distinguish overlapping windows/tabs, browser termination,
crash, power loss, or OS sleep without a final callback. It can also be evicted
or cleared. A process killed before its observer callback cannot persist its
unknown duration. Exact fatal-hang detection and durable per-event delivery need
an independent native watchdog/acknowledged outbox; they remain unimplemented.
Do not use unknown-exit reports as the severe-stall KPI numerator.

## Input attempts, qualified samples and latency

`client_input_responsiveness` reports one aggregate per active input area per
30-second window. The bounded area vocabulary is `composer`, `search`, `settings`
and `other_input`. It covers chat inputs, semantic search controls, the actual
project-search input marker and editable controls in `.modal-settings`. Password
fields are excluded. Unmarked editable controls remain `other_input`; iframe
contents and inputs inside closed shadow roots are not inspected.

- `input_attempt_count` counts trusted DOM keydown attempts while the API is
  supported and foreground. It includes fast attempts; synthetic events do not
  count. These are keyboard interactions, not characters or submitted messages.
- `qualified_sample_count` counts Event Timing **keydown** records >=16ms. Keyup,
  beforeinput and pointer records cannot duplicate a keyboard sample. Duplicate
  or pre-consent timing timestamps are ignored.
- `over_500ms_count` counts qualified samples with duration strictly >500ms.
- `max_input_to_presentation_ms` is Event Timing duration (input timestamp through
  the browser's next presentation), with its native 8ms quantization.
- `max_queue_delay_ms` is separately `processingStart-startTime`; absent timing
  metadata stays null. It is not the same as total input-to-presentation time.

The supported sample rate is `sum(over_500ms_count) /
sum(qualified_sample_count)` for the same area/eligible exposure. It is explicitly
the rate **among API-qualified samples**, not all keystrokes. A zero denominator
means **not calculable**. Counts are independent of window maxima and continue
for the full session after the legacy report cap. An attempt with no exposed
Event Timing record does not become a manufactured 0ms sample.

The DOM attempt count is a separate coverage counter: the API censors records
below 16ms, targets can disappear, IME/mobile input may not produce keydowns,
and API delivery can cross a window boundary. Consequently dividing a window's
slow samples by its raw attempts does not establish an all-input latency rate.
The complete all-input/IME rate remains not calculable with this candidate.

The historical `client_chat_interaction_latency` event keeps its >=200ms,
chat-only 30-second maximum and 20-reports-per-page-session cap. Its
`interaction_count` remains slow DOM Event Timing entries in that window,
including pointer interactions. It is never a denominator for the new input
rate. Strict 500ms boundary tests use reported duration; real QA should also use
600ms to avoid confusing API quantization with measurement error.

## Scroll frames versus scroll freeze

`client_chat_scroll_frames` reports sampled chat-scroll cadence independently of
`client_chat_scroll_frozen`. Trusted wheel/scroll activity in the chat log arms
rAF for up to one second after activity, with a hard budget of 120 callbacks per
30-second window. Idle pages schedule no frame loop. It retains only counters
and a maximum. Fields include `frame_count`, `interval_count`, `over_50ms_count`,
`max_frame_interval_ms`, and `sampling_truncated`.

`interval_count` counts actual within-burst adjacent frame intervals, not first
frames of bursts. It is the only suitable denominator for a sampled >50ms frame
rate. Truncated windows describe only their sampled prefix; never extrapolate
them to all scrolling. Visibility changes cancel/discard sampling, >=5s suspended
frame gaps are discarded as ambiguous sleep/blockage, and the exposure clock
also rejects sleep. Unsupported or unmeasurable values stay null.

The existing frozen event continues describing compositor/scroll-ceiling failure
and its existing structural evidence. A frame gap alone does not synthesize a
freeze, nor does successful scrolling prove the absence of a main-thread stall.
Daily frozen-user / DAU needs an existing, verified account-day DAU source and
matching eligible cohort. Neither freeze-event counts nor installation counts
are DAU. Without that identity/DAU join the requested user ratio is not calculable.

## Resource budget and local measurement

Budgets for new collection: <1% renderer CPU (300ms per 30-second window),
<256KiB retained collector heap, <=120 sampled frames/window, constant-size
state (four input areas, one checkpoint <=512 bytes), and <=8KiB of ordinary
aggregate payloads/window for all four active areas plus heartbeats and one frame
summary. Legacy chat maxima add at most 20 events/session. Severe tasks are
uncapped by design and add one immediate report and one checkpoint write each.
Transport framing/TLS and existing forensic census work are separate from the
payload/collector budget. The grant check adds one <=3s config request.

A reproducible local headless Chromium 148 fixture bundled the real source
collectors, injected 10,000 small-task callbacks and 10,000 input callbacks, and
used 26 trusted keyboard attempts. OS renderer process CPU from CDP
`SystemInfo.getProcessInfo` was **17.974ms**; renderer task duration was 11.445ms.
GC-to-GC retained JS heap increased **128,276 bytes**. Eight local ingest requests
used **7,086 JSON bytes** for four active input areas, two heartbeats, the
legacy maximum and one scroll-frame summary. No production endpoint or actual Open Design runtime was used.

These are fixture results, not an all-platform result. The measurement includes
collector callback work and local serialization/delivery; it does not exercise
actual PerformanceObserver entry delivery, reaching the frame budget,
the existing freeze forensic census, production network behavior, or Electron
on Windows/macOS. The unapplied schema patch would additionally change the
serializer path; profiling must be refreshed after it lands. The script and raw
JSON are retained beside the task logs outside the repository.

## Verification and QA handoff

New fake-clock/source-path tests cover severe threshold preservation, aggregation,
clean/unsupported/background/sleep denominator windows, best-effort recovery,
consent changes, stale grant responses, strict input threshold, fast attempt
counts with null timings, continued counts beyond the legacy cap, search/settings,
password exclusion, scroll-frame separation and the frame budget. Existing chat
health/protocol/freeze tests explicitly opt into metrics. Two schema-admission
assertions and the delayed-transport consent assertion remain red until the
protected-file patch is authorized. The two new collector suites were also run
against the original `aa88f4387` collectors: all 11 then-existing regressions
failed; the candidate fixes them. The test-only consent helper was present in
that baseline harness, but neither original collector was modified.

Before QA, resolve the protected-file blockers, build contracts, rerun the
focused tests and repo `pnpm typecheck` / `pnpm guard`, and profile the final sink.
No full web or daemon test suite is required locally. QA must then:

1. On macOS and Windows, install the candidate version, grant metrics and verify
   envelope/version/identity and all four aggregate event names in a local sink.
   Repeat startup, new-project entry and preview while typing/scrolling.
2. Use a local test harness to block the foreground main thread for 5000–6000ms.
   Verify the immediate long-task duration and window count; repeat a burst of
   smaller tasks and confirm only the aggregate grows. Never run this in prod.
3. In the chat composer, project search and settings, type fast and then inject
   a 600ms handler. Confirm attempt/sample/slow counts are separate from maxima,
   queue time differs from total presentation time, and counts continue after
   twenty legacy windows. Test IME/mobile separately and record coverage gaps.
4. Scroll a long chat normally and with a controlled 80–200ms render stall.
   Verify the independent frame event, `interval_count`, truncation and no
   invented frozen event. Exercise a real compositor freeze separately.
5. Hide/reveal, suspend/resume and disable each API in the harness. Verify null
   unmeasurable windows, no qualified denominator during those intervals, and
   no stale entry attribution after reveal.
6. Revoke metrics before transport initialization and during activity; verify
   no delayed sends, no resumed old buffer after re-grant, and no new collection.
   Test unreadable daemon consent and failed storage without breaking the app.
7. Kill the renderer after a severe callback checkpoint, restart and verify its
   diagnostic recovery summary. Kill it before the callback and verify only an
   unknown/null duration, not a synthetic 5s event. Test multiple app windows.
8. Profile CPU/heap/network on physical macOS/Windows machines, including the
   schema-valid transport and existing freeze census. Attach exact build IDs,
   traces, consent state, API support and test steps.

Owners and dates for the native watchdog, acknowledged/deduplicated replay,
complete IME/cross-frame input coverage, user identity/DAU aggregation and remaining
platform profiling are unassigned pending integration-owner scheduling. Do not
mark these residuals complete. Real ingestion, QA/product sign-off and at least
seven days of post-release observation are still required; a 10/22 release
cannot have seven-day evidence before 10/29.
