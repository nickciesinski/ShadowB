'use strict';
// 2026-09-12 — the pre-registered Novig venue test.
//
// config/novig-fill-test.json is a COMMITMENT, not a note. Its whole value is
// that the decision rule was fixed before the data arrived; a bar quietly
// loosened after a bad fortnight is worth nothing. These tests are what make
// moving it a deliberate, visible act rather than an edit nobody notices.
const test = require('node:test');
const assert = require('node:assert');
const cfg = require('../config/novig-fill-test.json');

test('the decision rule is fixed and has not drifted', () => {
  const d = cfg.decision_rule;
  assert.strictEqual(d.bar, '> 0 with |t| >= 2, clustered by game_key');
  assert.strictEqual(d.minimum_sample, 40);
  assert.strictEqual(d.measured_from, '2026-09-12');
  assert.match(d.primary, /FILLED orders only/,
    'measuring unfilled orders as if they were bets is the survivorship trap');
});

test('it is clustered by game, like every other measurement here', () => {
  assert.match(cfg.decision_rule.note, /clustered by game/i);
});

test('the posting rule is one rule, not a judgement call', () => {
  const p = cfg.posting_rule;
  assert.match(p.price, /10 cents/);
  assert.match(p.price, /rounded DOWN/, 'rounding up quotes a worse price than intended');
  assert.match(p.stake, /flat/);
  assert.ok(p.cancel, 'an order with no cancel time never resolves to unfilled');
});

test('kill conditions are stated in advance', () => {
  assert.ok(Array.isArray(cfg.what_would_kill_it) && cfg.what_would_kill_it.length >= 3,
    'a test that cannot fail is not a test');
  assert.ok(cfg.what_would_kill_it.some(k => /<= 0/.test(k)));
});

test('the pilot is labelled as not evidence', () => {
  const p = cfg.pilot_2026_09_11;
  assert.match(p._warning, /ONE DAY/);
  assert.match(p._warning, /must not be quoted/,
    'the t of 4.5 from four similar observations is an artifact');
  assert.strictEqual(p.filled, 4);
  assert.strictEqual(p.orders, 8);
});

test('the pilot numbers are internally consistent', () => {
  const p = cfg.pilot_2026_09_11;
  assert.strictEqual(p.filled / p.orders, p.fill_rate);
  // capture ratio = filled CLV / mean CLV across all eight
  const meanAll = (p.filled_mean_clv_pp + p.missed_mean_clv_pp) / 2;
  assert.ok(Math.abs(p.filled_mean_clv_pp / meanAll - p.clv_capture_ratio) < 0.02,
    'capture ratio must match the CLV figures it is derived from');
  // the venue is the whole difference between the two net-edge figures
  const delta = p.filled_net_edge_at_novig_pp - p.filled_net_edge_at_book_pp;
  assert.ok(Math.abs(delta - p.filled_mean_price_gain_pp) < 0.05,
    'novig net minus book net must equal the price improvement');
});

test('nothing in this config stakes anything', () => {
  // Same rule as rule-c.json: if this ever gates a bet it must be a separate,
  // deliberate commit made AFTER the forward sample earns it.
  const flat = JSON.stringify(cfg).toLowerCase();
  assert.ok(/label and measurement only/.test(flat));
});
