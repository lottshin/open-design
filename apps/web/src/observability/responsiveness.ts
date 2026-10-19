/** Shared, fail-closed gate for responsiveness collectors. No SDK/bootstrap work. */
import { reportSafetyEvent } from '../analytics/error-tracking';

let consent = false;
let consentEpoch = 0;
let consentRevision = 0;
let consentRequest: AbortController | null = null;
const listeners = new Set<(enabled: boolean) => void>();
export function setResponsivenessConsent(enabled: boolean): void {
  if (consent === enabled) return;
  consentEpoch += 1;
  consent = enabled;
  for (const listener of listeners) listener(enabled);
}
/** Confirm the UI decision against the daemon's strict readMetricsConsent path.
 * A general app-config fallback is not evidence of readable consent. */
export async function refreshResponsivenessConsent(enabled: boolean): Promise<void> {
  const revision = ++consentRevision;
  consentRequest?.abort(); consentRequest = null;
  setResponsivenessConsent(false);
  if (!enabled) return;
  const request = new AbortController();
  consentRequest = request;
  const timeout = setTimeout(() => request.abort(), 3_000);
  try {
    const response = await fetch('/api/analytics/config', { signal: request.signal, cache: 'no-store' });
    const config: unknown = response.ok ? await response.json() : null;
    if (revision === consentRevision && config && typeof config === 'object'
      && (config as Record<string, unknown>).enabled === true) setResponsivenessConsent(true);
  } catch { /* Unreadable consent stays disabled. */ }
  finally {
    clearTimeout(timeout);
    if (consentRequest === request) consentRequest = null;
  }
}
export function responsivenessConsent(): boolean { return consent; }
export function onResponsivenessConsent(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function responsivenessVisible(): boolean {
  return consent && typeof document !== 'undefined' && document.visibilityState === 'visible';
}
export function reportResponsiveness(event: string, props: Record<string, unknown>): void {
  if (!consent) return;
  // The existing transport builds the common envelope and validates registered
  // metric schemas with parseClientMetricEvent, stripping URLs and extra fields.
  const epoch = consentEpoch;
  reportSafetyEvent(event, { metric_schema_version: 1, ...props }, {
    currentUrlOverride: '',
    // A later re-grant must not release samples buffered under an older grant.
    shouldSend: () => consent && consentEpoch === epoch,
  });
}

/** Long timer gaps are ambiguous (sleep OR blockage), never qualified exposure. */
export function createExposureClock() {
  let last = performance.now();
  let wall = Date.now();
  let visible = responsivenessVisible();
  let interrupted = false;
  const visibility = () => { interrupted = true; };
  document.addEventListener('visibilitychange', visibility);
  return {
    tick() {
      const now = performance.now();
      const nextWall = Date.now();
      const elapsed = now - last;
      const qualified = visible && responsivenessVisible() && !interrupted
        && elapsed > 0 && elapsed <= 35_000 && Math.abs(nextWall - wall - elapsed) < 1_000;
      last = now;
      wall = nextWall;
      visible = responsivenessVisible();
      interrupted = false;
      return { qualified, elapsed: qualified ? Math.round(elapsed) : null };
    },
    reset() {
      last = performance.now(); wall = Date.now();
      visible = responsivenessVisible(); interrupted = false;
    },
    stop() { document.removeEventListener('visibilitychange', visibility); },
  };
}
