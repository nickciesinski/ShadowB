'use strict';
// CLI: node scripts/drift-guard.js [days]
// Standalone run of the split-drift circuit-breaker.
require('dotenv').config();
const { runDriftGuard } = require('../src/drift-guard');

(async () => {
  const days = parseInt(process.argv[2], 10) || 7;
  const reverted = await runDriftGuard(days);
  console.log('[drift-guard] done. reverted:', JSON.stringify(reverted));
  process.exit(0);
})().catch((e) => { console.error('[drift-guard] FAILED:', e.message); process.exit(1); });
