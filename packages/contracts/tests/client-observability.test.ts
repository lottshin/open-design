import { expect, it } from 'vitest';
import { buildClientTelemetryParams, parseClientMetricEvent } from '../src/analytics/client-metrics.js';
const common = {
  ...buildClientTelemetryParams({}, { eventId: 'event-test', deviceId: 'install-test', clientType: 'web', captureSource: 'web/error-tracking', env: 'test', reportedAt: '2026-10-19T00:00:00.000Z' }),
  metric_schema_version: 1, telemetry_capability: 'supported',
};
it('admits responsiveness fields through the common parser and strips private extras', () => {
  const parsed = parseClientMetricEvent('client_input_responsiveness', { ...common, area: 'composer', window_ms: 30_000, input_attempt_count: 40, qualified_sample_count: 10, over_500ms_count: 2, max_input_to_presentation_ms: 504, max_queue_delay_ms: 100, sample_floor_ms: 16, prompt: 'private', url: 'https://private.test', pid: 123 });
  expect(parsed).toMatchObject({ event_schema_version: 4, metric_schema_version: 1, qualified_sample_count: 10 });
  expect(parsed).not.toHaveProperty('prompt'); expect(parsed).not.toHaveProperty('url'); expect(parsed).not.toHaveProperty('pid');
});
it('preserves null unmeasurable counts and rejects negative counts', () => {
  const fields = { ...common, measurement: 'long_task', measurable: false, unavailable_reason: 'background_or_sleep', window_ms: null, long_task_count: null, severe_task_count: null, max_duration_ms: null };
  expect(parseClientMetricEvent('client_responsiveness_window', fields)).toMatchObject({ long_task_count: null });
  expect(parseClientMetricEvent('client_responsiveness_window', { ...fields, long_task_count: -1 })).toBeNull();
});
