// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExposureClock, refreshResponsivenessConsent, responsivenessConsent, setResponsivenessConsent, reportResponsiveness } from '../../src/observability/responsiveness';
import { clearExceptionTrackingContext, setExceptionTrackingContext } from '../../src/analytics/error-tracking';
beforeEach(() => { setResponsivenessConsent(false); });
afterEach(async () => { await refreshResponsivenessConsent(false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('treats unreadable or denied daemon consent as disabled despite a granted UI fallback', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true })));
  vi.stubGlobal('fetch', fetcher);
  await refreshResponsivenessConsent(true); expect(responsivenessConsent()).toBe(false);
  await refreshResponsivenessConsent(true); expect(responsivenessConsent()).toBe(false);
  await refreshResponsivenessConsent(true); expect(responsivenessConsent()).toBe(true);
});
it('does not grant from a stale response after a later opt-out', async () => {
  let resolve: (value: Response) => void = () => undefined;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>((r) => { resolve = r; })));
  const grant = refreshResponsivenessConsent(true);
  await refreshResponsivenessConsent(false);
  resolve(new Response(JSON.stringify({ enabled: true })));
  await grant; expect(responsivenessConsent()).toBe(false);
});
it('drops a timer gap longer than the foreground exposure budget', () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  setResponsivenessConsent(true);
  const clock = createExposureClock(); now = 90_000;
  expect(clock.tick()).toEqual({ qualified: false, elapsed: null });
  now += 30_000;
  expect(clock.tick()).toEqual({ qualified: true, elapsed: 30_000 });
  clock.stop();
});

it('drops buffered responsiveness metrics if consent was withdrawn before transport context arrives', () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(''));
  vi.stubGlobal('fetch', fetcher);
  clearExceptionTrackingContext();
  setResponsivenessConsent(true);
  reportResponsiveness('client_long_task', { duration_ms: 5_000 });
  setResponsivenessConsent(false);
  setExceptionTrackingContext({ apiKey: 'test', host: 'https://example.test', distinctId: 'test-install', clientType: 'web', osName: 'Mac OS X' });
  expect(fetcher).not.toHaveBeenCalled();
  clearExceptionTrackingContext();
});

it('does not release an old grant buffer after re-grant, but sends new samples', () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(''));
  vi.stubGlobal('fetch', fetcher);
  clearExceptionTrackingContext();
  setResponsivenessConsent(true);
  reportResponsiveness('client_long_task', { duration_ms: 5_000 });
  setResponsivenessConsent(false);
  setResponsivenessConsent(true);
  reportResponsiveness('client_long_task', { duration_ms: 6_000 });
  setExceptionTrackingContext({ apiKey: 'test', host: 'https://example.test', distinctId: 'test-install', clientType: 'web', osName: 'Mac OS X' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).properties.duration_ms).toBe(6_000);
  clearExceptionTrackingContext();
});

it('validates new metrics through the buffered transport and preserves occurrence time', () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(''));
  vi.stubGlobal('fetch', fetcher);
  clearExceptionTrackingContext();
  setResponsivenessConsent(true);
  const occurredAt = '2026-10-18T01:02:03.000Z';
  const fields = {
    telemetry_capability: 'supported', occurred_at: occurredAt,
    area: 'composer', window_ms: 30_000, input_attempt_count: 3,
    qualified_sample_count: 2, over_500ms_count: 1,
    max_input_to_presentation_ms: 600, max_queue_delay_ms: null, sample_floor_ms: 16,
    prompt: 'private', url: 'https://private.test', pid: 123,
  };
  reportResponsiveness('client_input_responsiveness', fields);
  reportResponsiveness('client_input_responsiveness', { ...fields, over_500ms_count: 3 });
  setExceptionTrackingContext({ apiKey: 'test', host: 'https://example.test', distinctId: 'test-install', appSessionId: 'session-test', clientType: 'web', osName: 'Mac OS X' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(payload.timestamp).toBe(occurredAt);
  expect(payload.properties).toMatchObject({
    event_schema_version: 4, metric_schema_version: 1, occurred_at: occurredAt,
    device_id: 'test-install', app_session_id: 'session-test',
    max_queue_delay_ms: null, qualified_sample_count: 2,
  });
  for (const key of ['prompt', 'url', 'pid', '$current_url']) {
    expect(payload.properties).not.toHaveProperty(key);
  }
  clearExceptionTrackingContext();
});
