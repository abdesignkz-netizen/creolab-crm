import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getDocumentSignMeta } from '@creolab/contracts';
import { renderPublicSignHtml } from './publicSignPage.ts';

describe('server rendered public sign metadata', () => {
  it('puts crawler metadata in initial HTML without a bearer token', () => {
    const html = renderPublicSignHtml('<html><head><title>old</title></head><body></body></html>', getDocumentSignMeta('AVR', { number: '123', date: '2026-09-28' }), 'https://bsqr.kz');
    assert.match(html, /<title>BasQar — Умный контур ведения бизнеса<\/title>/);
    assert.match(html, /property="og:title" content="BasQar — Умный контур ведения бизнеса"/);
    assert.match(html, /Документ на подпись: АВР №123/);
    assert.match(html, /og\/document-sign-v1\.png/);
    assert.doesNotMatch(html, /token|123.*secret/i);
  });
});
