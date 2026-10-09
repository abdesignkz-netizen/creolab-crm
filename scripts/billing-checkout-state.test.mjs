import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { billingCheckoutState } from '../apps/web/src/lib/billingCheckoutState.ts';

const now = Date.parse('2026-10-08T10:00:00Z');
const checkout = (statuses, expiresAt = '2026-10-09T10:00:00Z', status = 'PENDING_PAYMENT') => ({
  order: { status, expiresAt }, payments: statuses.map(status => ({ status })),
});

test('expired unresolved card payment remains visible and refreshes without allowing a new attempt', () => {
  assert.deepEqual(billingCheckoutState(checkout(['PROCESSING'], '2026-10-07T10:00:00Z'), false, now), {
    canStartPayment: false, showPaymentFlow: true, shouldRefresh: true,
  });
});

test('manual pending payment refreshes when its link or confirmation can arrive', () => {
  assert.equal(billingCheckoutState(checkout(['PENDING']), false, now).shouldRefresh, true);
  assert.equal(billingCheckoutState(checkout(['FAILED']), false, now).shouldRefresh, false);
});

test('closed orders stop refresh even after provider return and cannot reopen a payment', () => {
  for (const status of ['PAID', 'CANCELLED', 'EXPIRED']) {
    assert.deepEqual(billingCheckoutState(checkout(['PROCESSING'], undefined, status), true, now), {
      canStartPayment: false, showPaymentFlow: false, shouldRefresh: false,
    });
  }
  assert.deepEqual(billingCheckoutState(checkout([], '2026-10-07T10:00:00Z'), false, now), {
    canStartPayment: false, showPaymentFlow: false, shouldRefresh: false,
  });
});

// Run the actual page handlers with controlled hooks and API promises. This keeps
// navigation and requests deterministic without opening a real payment provider.
const checkoutPageCode = transformSync(readFileSync(new URL('../apps/web/src/pages/BillingCheckoutPage.tsx', import.meta.url), 'utf8'), {
  loader: 'tsx', format: 'cjs', jsx: 'automatic',
}).code;
const paymentLink = 'https://payments.example.test/checkout';
const pageData = (payments = []) => ({
  ...checkout([], '2099-10-09T10:00:00Z'),
  payments, methods: { card: true, bankTransfer: true },
});
const cardPayment = () => pageData([{ method: 'CARD', status: 'PROCESSING', checkoutUrl: paymentLink }]);

function checkoutPage({ billingOrder = async () => pageData(), billingPay = async () => cardPayment(), billingCheckOrder, returning = false, navigate = () => {} } = {}) {
  const hooks = [], effects = [], intervals = new Map(), redirects = [], listeners = new Map();
  let cursor = 0, tree, nextInterval = 0, reads = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(fn, deps) {
      const index = cursor++, previous = hooks[index];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        effects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: fn() };
        });
      }
    },
  };
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(checkoutPageCode, {
    module, exports: module.exports,
    window: {
      location: { assign(url) { navigate(url); redirects.push(url); } },
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name) { listeners.delete(name); },
    },
    setInterval(fn) { intervals.set(++nextInterval, fn); return nextInterval; },
    clearInterval(id) { intervals.delete(id); },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === 'react-router-dom') return {
        Link: 'Link', useParams: () => ({ orderId: 'order-1' }),
        useSearchParams: () => [new URLSearchParams(returning ? 'return=1' : '')],
      };
      if (name === '../lib/api') return { api: {
        billingOrder: () => { reads++; return billingOrder(); }, billingPay, billingCheckOrder,
      } };
      if (name === '../lib/billingCheckoutState') return { billingCheckoutState };
      if (name === '../components/CancelBillingOrder') return { CancelBillingOrder: 'CancelBillingOrder' };
      if (name === '../components/InlineFeedback') return { InlineFeedback: 'InlineFeedback' };
      if (name === '../components/NavIcon') return { NavIcon: 'NavIcon' };
      if (name === '../components/BillingCheckoutUi') return {
        useBillingText: () => (...values) => values[0], useBillingError: () => error => error.message,
        BillingStatus: 'BillingStatus', BuyerForm: 'BuyerForm', billingMoney: String, billingDate: String,
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  function render() {
    cursor = 0;
    tree = module.exports.BillingCheckoutPage();
    effects.splice(0).forEach(fn => fn());
  }
  function nodes(node) {
    if (Array.isArray(node)) return node.flatMap(nodes);
    return node && typeof node === 'object' ? [node, ...nodes(node.props?.children ?? null)] : [];
  }
  function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    return node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
  }
  function button(label) {
    const match = nodes(tree).find(node => node.type === 'button' && text(node).includes(label));
    assert.ok(match, `Missing button: ${label}`);
    return match;
  }
  render();
  return {
    async settle() { await new Promise(resolve => setImmediate(resolve)); render(); },
    chooseCard() { button('Банковская карта').props.onClick(); render(); },
    pay() { button('Оплатить картой').props.onClick(); render(); },
    checkPayment() { button('Проверить оплату').props.onClick(); render(); },
    poll() { for (const fn of [...intervals.values()]) fn(); },
    restoreFromBackCache() { listeners.get('pageshow')?.({ persisted: true }); },
    get error() { return nodes(tree).filter(node => node.type === 'InlineFeedback' && node.props.kind === 'error').map(text).join(''); },
    get text() { return text(tree); },
    get busy() { return nodes(tree).find(node => node.type === 'CancelBillingOrder').props.busy; },
    get reads() { return reads; },
    get redirects() { return redirects; },
    get paymentUrl() { return nodes(tree).find(node => node.type === 'a' && node.props.href === paymentLink)?.props.href; },
  };
}

test('successful card navigation does not issue a refresh that can fail during page unload', async () => {
  let loaded = false;
  const page = checkoutPage({ billingOrder: async () => {
    if (loaded) throw new Error('Fetch aborted during navigation');
    loaded = true;
    return pageData();
  } });
  await page.settle();
  page.chooseCard();
  page.pay();
  await page.settle();
  assert.deepEqual(page.redirects, [paymentLink]);
  assert.equal(page.error, '');
  assert.equal(page.reads, 1);
  assert.equal(page.busy, true);
  page.poll();
  await page.settle();
  assert.equal(page.reads, 1);
});

test('polling already in flight cannot add an error or overwrite checkout after card navigation', async () => {
  for (const fail of [true, false]) {
    let loaded = false, finishPoll;
    const page = checkoutPage({ returning: true, billingOrder: () => {
      if (!loaded) { loaded = true; return Promise.resolve(pageData()); }
      return new Promise((resolve, reject) => { finishPoll = () => fail ? reject(new Error('Navigation aborted fetch')) : resolve(pageData()); });
    } });
    await page.settle();
    page.poll();
    page.chooseCard();
    page.pay();
    await page.settle();
    finishPoll();
    await page.settle();
    assert.deepEqual(page.redirects, [paymentLink]);
    assert.equal(page.reads, 2);
    assert.equal(page.error, '');
    assert.equal(page.paymentUrl, paymentLink);
  }
});

test('a real card initialization error still refreshes the order and appears to the user', async () => {
  const page = checkoutPage({ billingPay: async () => { throw new Error('Платёж отклонён'); } });
  await page.settle();
  page.chooseCard();
  page.pay();
  await page.settle();
  assert.deepEqual(page.redirects, []);
  assert.equal(page.reads, 2);
  assert.equal(page.error, 'Платёж отклонён');
});

test('a failed browser navigation restores normal error handling', async () => {
  const page = checkoutPage({ navigate: () => { throw new Error('Navigation blocked'); } });
  await page.settle();
  page.chooseCard();
  page.pay();
  await page.settle();
  assert.deepEqual(page.redirects, []);
  assert.equal(page.reads, 2);
  assert.equal(page.error, 'Navigation blocked');
});

test('returning with browser Back resumes checkout polling and controls', async () => {
  let loaded = false;
  const page = checkoutPage({ billingOrder: async () => {
    if (loaded) return cardPayment();
    loaded = true;
    return pageData();
  } });
  await page.settle();
  page.chooseCard();
  page.pay();
  await page.settle();
  page.restoreFromBackCache();
  await page.settle();
  assert.equal(page.reads, 2);
  assert.equal(page.busy, false);
  assert.equal(page.error, '');
  page.poll();
  await page.settle();
  assert.equal(page.reads, 3);
});

test('verified provider failure is explained without blaming the bank and refreshes checkout', async () => {
  let failed = false;
  const page = checkoutPage({
    billingOrder: async () => failed ? pageData([{ method: 'CARD', status: 'FAILED' }]) : cardPayment(),
    billingCheckOrder: async () => { failed = true; return { status: 'failed', providerFailureCode: '99999' }; },
  });
  await page.settle();
  page.checkPayment();
  await page.settle();
  assert.match(page.text, /Freedom Pay завершил платёж с ошибкой платёжной системы \(99999\)/);
  assert.doesNotMatch(page.text, /Банк отклонил/);
  assert.equal(page.busy, false);
  assert.equal(page.reads, 2);
  assert.equal(page.error, '');
});
