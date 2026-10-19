import { createHash } from 'node:crypto';
import { buildPreviewObservabilityBridge } from '@open-design/contracts/runtime/preview-observability';
import { prependAfterDoctype } from '@open-design/contracts/runtime/html-injection-points';

// Live HTML forbids authored scripts. Allow only this exact, trusted observer
// by CSP hash; never allow unsafe-inline, eval, external or authored scripts.
const bridge = buildPreviewObservabilityBridge();
const script = bridge.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
export const LIVE_PREVIEW_OBSERVER_HASH = `sha256-${createHash('sha256').update(script).digest('base64')}`;
export function instrumentLivePreview(html: string): string {
  return prependAfterDoctype(html, bridge);
}
