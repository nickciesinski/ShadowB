'use strict';
// 2026-09-12 — auto-settling Novig orders Nick never came back to.
//
// Novig sends no fill notification, so checking means opening the app. Manual
// marking therefore under-records MISSES specifically — a fill is satisfying to
// record, a miss is not — and the misses are the half that makes a fill rate
// mean anything. The 2026-09-11 finding that fills captured only 44% of the CLV
// on offer exists solely because the four misses were written down.
//
// The headline test is `an error here must understate the edge, never overstate
// it`. If the grace period is too short, a real fill checked the next morning
// gets recorded as a miss. That is the acceptable direction: it makes the venue
// look worse than it is, and a pessimistic bias cannot talk anyone into staking.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Stub src/db before loading the module under test.
const realResolve = Module._resolveFilename;
let stub;
const load = (client) => {
  stub = client;
  const key = require.resolve('../src/db');
  require.cache[key] = { id: key, filename: key, loaded: true, exports: { getClient: () => stub } };
  delete require.cache[require.resolve('../src/novig-settle')];
  return require('../src/novig-settle');
};

/** Minimal supabase double: novig_orders + performance_log. */
function fakeSb({ orders, picks }) {
  const updates = [];
  return {
    updates,
    from(table) {
      if (table === 'novig_orders') {
        const api = {
          select: () => api,
          eq: (col, val) => {
            if (col === 'state' && val === 'ordered' && !api._updating) {
              return Promise.resolve({ data: orders.filter(o => o.state === 'ordered'), error: null });
            }
            return api;
          },
          update(patch) { api._updating = true; api._patch = patch; return api; },
          then: undefined,
        };
        // update(...).eq(pick_id).eq(state) resolves
        api.eq = (col, val) => {
          if (api._updating) {
            if (col === 'pick_id') { api._id = val; return api; }
            updates.push({ pick_id: api._id, patch: api._patch });
            return Promise.resolve({ error: null });
          }
          if (col === 'state' && val === 'ordered') {
            return Promise.resolve({ data: orders.filter(o => o.state === 'ordered'), error: null });
          }
          return api;
        };
        return api;
      }
      // performance_log
      return {
        select: () => ({ in: () => Promise.resolve({ data: picks, error: null }) }),
      };
    },
  };
}

const NOW = '2026-09-12T12:00:00Z';

test('an order whose game started long ago settles to unfilled', async () => {
  const sb = fakeSb({
    orders: [{ pick_id: 'a', state: 'ordered' }],
    picks: [{ pick_id: 'a', commence_time: '2026-09-12T01:00:00Z' }], // 11h before now
  });
  const { settleStaleNovigOrders } = load(sb);
  const r = await settleStaleNovigOrders({ now: NOW });
  assert.strictEqual(r.settled, 1);
  assert.strictEqual(sb.updates[0].patch.state, 'unfilled');
});

test('an error here must understate the edge, never overstate it', async () => {
  // Inside the grace window the order is LEFT OPEN. The failure mode we accept
  // is recording a fill as a miss (pessimistic); the one we refuse is deciding
  // an unfilled order was fine to forget.
  const sb = fakeSb({
    orders: [{ pick_id: 'a', state: 'ordered' }],
    picks: [{ pick_id: 'a', commence_time: '2026-09-12T09:00:00Z' }], // 3h before now
  });
  const { settleStaleNovigOrders } = load(sb);
  const r = await settleStaleNovigOrders({ now: NOW });
  assert.strictEqual(r.settled, 0, 'still inside the 6h grace period');
  assert.strictEqual(r.skipped, 1);
});

test('a game that has not started is never settled', async () => {
  const sb = fakeSb({
    orders: [{ pick_id: 'a', state: 'ordered' }],
    picks: [{ pick_id: 'a', commence_time: '2026-09-13T01:00:00Z' }], // tomorrow
  });
  const { settleStaleNovigOrders } = load(sb);
  assert.strictEqual((await settleStaleNovigOrders({ now: NOW })).settled, 0);
});

test('an order with no commence_time is left open rather than guessed', async () => {
  // An order wrongly settled is a lost observation, and this test is the only
  // thing standing between "we cannot prove it started" and "call it a miss".
  const sb = fakeSb({
    orders: [{ pick_id: 'a', state: 'ordered' }],
    picks: [{ pick_id: 'a', commence_time: null }],
  });
  const { settleStaleNovigOrders } = load(sb);
  assert.strictEqual((await settleStaleNovigOrders({ now: NOW })).settled, 0);
});

test('already-settled rows are untouched', async () => {
  const sb = fakeSb({
    orders: [{ pick_id: 'a', state: 'filled' }, { pick_id: 'b', state: 'unfilled' }],
    picks: [{ pick_id: 'a', commence_time: '2026-09-11T01:00:00Z' }],
  });
  const { settleStaleNovigOrders } = load(sb);
  const r = await settleStaleNovigOrders({ now: NOW });
  assert.strictEqual(r.settled, 0);
  assert.strictEqual(sb.updates.length, 0);
});

test('the update is guarded so a fill marked mid-run is not clobbered', async () => {
  // The write re-asserts state='ordered'. Without it, a fill Nick marks while
  // the job is running would be overwritten with 'unfilled'.
  const src = require('fs').readFileSync(require.resolve('../src/novig-settle'), 'utf8');
  assert.match(src, /\.eq\('state',\s*'ordered'\)/);
});

test('no Supabase means no claim either way', async () => {
  const { settleStaleNovigOrders } = load(null);
  const r = await settleStaleNovigOrders({ now: NOW });
  assert.strictEqual(r.settled, 0);
  assert.strictEqual(r.reason, 'supabase_not_configured');
});
