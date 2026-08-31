'use strict';
// 2026-08-31 — module export contracts.
//
// Written after src/calibration.js (a unit-SIZING feedback loop) was
// accidentally overwritten by an unrelated new module of the same name. The
// suite stayed 100% green because nothing tested that game-model.js could
// still import what it requires; trigger4 failed in production instead, with
// "getCalibrationMultiplier is not a function", and pick generation stopped.
//
// A unit test suite that only tests the modules it knows about cannot catch a
// module being replaced. These assertions pin the seams between files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// Each entry: the module, and the exports another file destructures from it.
const CONTRACTS = {
  'calibration.js': ['loadCalibration', 'getCalibrationMultiplier'],
  'prob-calibration.js': ['calibrate', 'calibratedEdge', 'loadCalibration'],
  'rule-c.js': ['isRuleCEligible'],
  'venue-cost.js': ['venueCost', 'netEdgeAtVenue'],
  'feature-clv.js': ['attributeByFeature', 'corr', 'tStat', 'gamesNeeded'],
  'price-lib.js': ['selectGradedPrice'],
  'market-pricing.js': ['americanToImpliedProb', 'isValidAmericanOdds'],
};

for (const [file, exports] of Object.entries(CONTRACTS)) {
  test(`src/${file} exports ${exports.join(', ')}`, () => {
    const mod = require(path.join(SRC, file));
    for (const name of exports) {
      assert.strictEqual(typeof mod[name], 'function',
        `src/${file} must export ${name} as a function — something imports it`);
    }
  });
}

test('calibration.js and prob-calibration.js are genuinely different modules', () => {
  // The specific confusion that caused the outage: two files, similar names,
  // one overwriting the other. Pin that they do different jobs.
  const sizing = require(path.join(SRC, 'calibration.js'));
  const prob = require(path.join(SRC, 'prob-calibration.js'));
  assert.strictEqual(typeof sizing.getCalibrationMultiplier, 'function',
    'calibration.js is the unit-SIZING loop');
  assert.strictEqual(typeof prob.calibrate, 'function',
    'prob-calibration.js is the PROBABILITY scale');
  assert.strictEqual(prob.getCalibrationMultiplier, undefined,
    'prob-calibration.js must not masquerade as the sizing loop');
});

test('every require of a local src module resolves', () => {
  // Catches a rename that missed a call site anywhere in src/ or scripts/.
  const dirs = [SRC, path.join(__dirname, '..', 'scripts')];
  const missing = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
        const target = path.resolve(dir, m[1]);
        const ok = fs.existsSync(target) || fs.existsSync(`${target}.js`)
          || fs.existsSync(`${target}.json`) || fs.existsSync(`${target}.mjs`);
        if (!ok) missing.push(`${path.basename(dir)}/${f} -> ${m[1]}`);
      }
    }
  }
  assert.deepStrictEqual(missing, [], `unresolvable local requires:\n${missing.join('\n')}`);
});
