'use strict';
// =============================================================
// src/config.js — Core configuration, constants, sheet mappings
// Replaces: Core Config (Apps Script)
// =============================================================

require('dotenv').config();

// ── Google Sheets ──────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Sheet tab names (mirrors your 44 existing tabs)
const SHEETS = {
  // Data collection
  PLAYER_STATS:        'PlayerStats',
  TEAM_STATS:          'TeamStats',
  GAME_ODDS:           'GameOdds',
  HISTORICAL_ODDS:     'HistoricalOdds',

  // Predictions
  MLB_PREDICTIONS:     'MLBPredictions',
  NBA_PREDICTIONS:     'NBAPredictions',
  NFL_PREDICTIONS:     'NFLPredictions',
  PLAYER_PROPS:        'PlayerProps',
  PLATFORM_COMBOS:     'PlatformCombos',

  // Tracking
  CLV_SNAPSHOT:        'CLVSnapshot',
  BANKROLL:            'Bankroll',
  PERFORMANCE:         'Performance',
  BACKTESTING:         'Backtesting',

  // Weights & config
  WEIGHTS:             'Weights',
  PLAYER_TIERS:        'PlayerTiers',
  CONFIG:              'Config',

  // Output / dashboard
  DAILY_PICKS:         'DailyPicks',
  EMAIL_LOG:           'EmailLog',
  DIAGNOSTIC_LOG:      'DiagnosticLog',

  // Test tabs (used during parallel testing phase)
  TEST_MLB:            'TEST_MLBPredictions',
  TEST_NBA:            'TEST_NBAPredictions',
  TEST_PROPS:          'TEST_PlayerProps',
};

// ── API Keys ────────────────────────────────────────────────────
const ODDS_API_KEY   = process.env.ODDS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ODDS_API_BASE  = 'https://api.the-odds-api.com/v4';

// ── Email ────────────────────────────────────────────────────────
const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD  = process.env.GMAIL_APP_PASSWORD;
const EMAIL_RECIPIENTS   = (process.env.EMAIL_RECIPIENTS || '').split(',').filter(Boolean);

// ── Sports config ────────────────────────────────────────────────
const SPORTS = {
  MLB:  { key: 'baseball_mlb',       season: 'regular' },
  NBA:  { key: 'basketball_nba',     season: 'regular' },
  NFL:  { key: 'americanfootball_nfl', season: 'regular' },
  NCAAB:{ key: 'basketball_ncaab',   season: 'regular' },
};

const MARKETS = ['h2h', 'spreads', 'totals'];

// ── Environment ──────────────────────────────────────────────────
const IS_TEST = process.env.NODE_ENV !== 'production';

// ── Validation ───────────────────────────────────────────────────
function validateConfig() {
  const required = [
    'SPREADSHEET_ID',
    'ODDS_API_KEY',
    'OPENAI_API_KEY',
    'GMAIL_USER',
    'GMAIL_APP_PASSWORD',
    'GOOGLE_SERVICE_ACCOUNT_JSON',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = {
  SPREADSHEET_ID,
  SHEETS,
  ODDS_API_KEY,
  ODDS_API_BASE,
  OPENAI_API_KEY,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  EMAIL_RECIPIENTS,
  SPORTS,
  MARKETS,
  IS_TEST,
  validateConfig,
};
