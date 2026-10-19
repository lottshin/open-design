import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { instrumentLivePreview, LIVE_PREVIEW_OBSERVER_HASH } from '../../src/live-artifacts/preview-metrics.js';
import { setLiveArtifactPreviewHeaders } from '../../src/live-artifacts/http-helpers.js';
import type { Response } from 'express';

describe('live artifact observer isolation', () => {
  it('allows only the exact observer script and keeps authored scripts and origin access blocked', () => {
    const html = instrumentLivePreview('<!doctype html><h1>Live</h1><script>privateScript()</script>');
    const body = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!;
    expect(LIVE_PREVIEW_OBSERVER_HASH).toBe(`sha256-${createHash('sha256').update(body).digest('base64')}`);
    const headers = new Map<string, string>();
    setLiveArtifactPreviewHeaders({ setHeader: (key: string, value: string) => headers.set(key, value) } as unknown as Response);
    const csp = headers.get('Content-Security-Policy')!;
    expect(csp).toContain(`script-src '${LIVE_PREVIEW_OBSERVER_HASH}'`);
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain(createHash('sha256').update('privateScript()').digest('base64'));
    expect(html).toContain('<h1>Live</h1>');
  });
});
