import test from 'node:test';
import assert from 'node:assert/strict';
import { avrEditorContext, mergeAvrRequisitesRefresh } from '../apps/web/src/lib/avrEditorContext.ts';

test('saved AVR shows exactly its own parties, even when current organization or buyer changed', () => {
  const context={deal:{id:'deal'},organization:{legalName:'Current seller',bin:'222',iban:'current bank'},company:{id:'new-buyer',name:'Current buyer',bin:'333'}};
  const document={companyId:'saved-buyer',source:{seller:{legalName:'Saved seller',bin:'111',legalAddress:'Seller address'},buyer:{name:'Saved buyer',bin:'444',legalAddress:'Buyer address'}}};
  for (const externalSystem of [null,'BASQAR','IS_ESF']) {
    const shown=avrEditorContext(context,{...document,externalSystem});
    assert.deepEqual(shown.organization,document.source.seller);
    assert.deepEqual(shown.company,{...document.source.buyer,id:'saved-buyer'});
    assert.equal(shown.organization.iban,undefined);
  }
  assert.equal(avrEditorContext(context,null),context);
});

test('refreshing one side never silently requests changes to the other', () => {
  assert.equal(mergeAvrRequisitesRefresh(undefined,'buyer'),'buyer');
  assert.equal(mergeAvrRequisitesRefresh('buyer','buyer'),'buyer');
  assert.equal(mergeAvrRequisitesRefresh('buyer','seller'),'all');
  assert.equal(mergeAvrRequisitesRefresh('all','buyer'),'all');
});
