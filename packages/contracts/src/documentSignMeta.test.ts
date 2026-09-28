import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BASQAR_PAGE_TITLE, getDocumentSignMeta, publicDocumentText } from './documentSignMeta.ts';

describe('public document signing metadata', () => {
  it('formats safe document descriptions for every supported type', () => {
    const avr = getDocumentSignMeta('AVR', { number: '123', date: '2026-09-28T00:00:00Z' });
    assert.equal(avr.pageTitle, BASQAR_PAGE_TITLE);
    assert.match(avr.description, /^Документ на подпись: АВР №123 от/);
    assert.equal(getDocumentSignMeta('invoice', { number: '№ 7' }).heading, 'Счёт №7');
    assert.equal(getDocumentSignMeta('contract', null).description, 'Документ на подпись в BasQar');
  });
  it('does not expose empty placeholders', () => {
    assert.equal(publicDocumentText(null), '');
    assert.equal(publicDocumentText('undefined'), '');
    assert.equal(getDocumentSignMeta('AVR', { number: null, date: null }).heading, 'Акт выполненных работ');
  });
});
