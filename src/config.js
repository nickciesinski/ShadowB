'use strict';
// =============================================================
// src/config.js — Core configuration, constants, sheet mappings
// =============================================================

require('dotenv').config();

// ── Google Sheets ──────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Sheet tab names — exact match to the 47 tabs in the spreadsheet
const SHEETS = {
  // Dashboard / output
  DASHBOARD:           'Dashboard',
  DAILY_PICKS:         'Daily_Combos',
  DAILY_PROPS:         'Daily_Props_Detail',
  DAILY_BETS:          'Daily_Bets',
  BETTING_INSIGHTS:    'Betting_Insights',

  // Odds & data
  GAME_ODDS:           'Today_Odds',
  ODDS_RAW:            'Odds_Raw_Data',
  HISTORICAL_ODDS:     'Historical_Results',
  CLOSING_ODDS:        'Closing_Odds_Snapshot',
  YESTERDAY_RESULTS:   'Yesterday_Results',
  SCHEDULE_CONTEXT:    'Schedule_Context',
  API_CACHE:           'API_Cache',

  // Player / team stats
  NBA_PLAYERS:         'NBA Players',
  MLB_PLAYERS:         'MLB Players',
  NFL_PLAYERS:         'NFL Players',
  NHL_PLAYERS:         'NHL Players',
  NBA_TEAM_STATS:      'NBA Team Stats',
  MLB_TEAM_STATS:      'MLB Team Stats',
  NFL_TEAM_STATS:      'NFL Team Stats',
  NHL_TEAM_STATS:      'NHL Team Stats',
  PLAYER_STATS:        'NBA Players',   // default for generic player stat calls
  TEAM_STATS:          'NBA Team Stats', // default for generic team stat calls

  // MLB specific
  MLB_PITCHERS:        'MLB Pitchers',
  MLB_PITCHER_MATCHUPS:'MLB Pitcher Matchups',

  // Props
  PLAYER_PROPS:        'Player_Props',
  PROP_COMBOS:         'Prop_Combos',
  PLATFORM_COMBOS:     'Prop_Combos',
  PROP_PERFORMANCE:    'Prop_Performance',
  PROP_STATUS:         'Prop_Status',
  PROP_CLV_OPENING:    'Prop_CLV_Opening',
  PROP_CLV_CLOSING:    'Prop_CLV_Closing',
  PROP_WEIGHTS_MLB:    'PropWeights_MLB',
  PROP_WEIGHTS_NBA:    'PropWeights_NBA',
  PROP_WEIGHTS_NFL:    'PropWeights_NFL',
  PROP_WEIGHTS_NHL:    'PropWeights_NHL',
  DAILY_COMBOS:        'Daily_Combos',

  // Predictions (write output here)
  NBA_PREDICTIONS:     'NBA',
  MLB_PREDICTIONS:     'MLB Pitcher Matchups',
  NFL_PREDICTIONS:     'NFL Team Stats',

  // Tracking / performance
  BANKROLL:            'Bankroll',
  PERFORMANCE:         'Performance Log',
  CLV_SNAPSHOT:        'Closing_Odds_Snapshot',
  CLV_MODIFIERS:       'CLV_Modifiers',
  CALIBRATION_DATA:    'Calibration_Data',
  CALIBRATION_PARAMS:  'Calibration_Parameters',
  INJURY_SUMMARY:      'Injury Summary',

  // Weights
  WEIGHTS:             'Weights_MLB',
  WEIGHTS_MLB:         'Weights_MLB',
  WEIGHTS_NBA:         'Weights_NBA',
  WEIGHTS_NFL:         'Weights_NFL',
  WEIGHTS_NHL:         'Weights_NHL',
  PLAYER_TIERS:        'NBA Players',

  // Optimization & logs
  WEIGHT_OPT_LOG:      'Weight_Optimization_Log',
  WEIGHT_OPT_RESULTS:  'Weight_Optimization_Results',
  INDIVIDUAL_OPT:      'Individual_Optimization_Results',
  GPT4_RECOMMENDATIONS:'GPT4_Recommendations',
  GPT4_AUTO_APPLIED:   'GPT4_Auto_Applied',
  ANALYZER_PROMPT:     'Analyzer_Prompt',
  API_USAGE:           'API_Usage',
  API_USAGE_LOG:       'API_Usage_Log',

  // Monitors
  TRIGGER_MONITOR:     'Trigger_Monitor',
  TRIGGER_MONITOR_8T:  'Trigger_Monitor_8T',
  SIMPLE_MONITOR:      'Simple_Monitor',

  // Logs
  DIAGNOSTIC_LOG:      'API_Usage_Log',
  EMAIL_LOG:           'API_Usage_Log',
  BACKTESTING:         'Historical_Results',
  GRADED_BETS:         'Yesterday_Results',
  BACKTEST_RESULTS:    'Historical_Results',

  // Config
  CONFIG:              'Dashboard',
};

// ── API Keys ────────────────────────────────────────────────────
const ODDS_API_KEY    = process.env.ODDS_API_KEY;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const ODDS_API_BASE   = 'https://api.the-odds-api.com/v4';

// ── Email ────────────────────────────────────────────────────────
const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const EMAIL_RECIPIENTS   = (process.env.EMAIL_RECIPIENTS || '').split(',').filter(Boolean);

// ── Sports config ────────────────────────────────────────────────
const SPORTS = {
  MLB:   { key: 'baseball_mlb',            season: 'regular' },
  NBA:   { key: 'basketball_nba',          season: 'regular' },
  NFL:   { key: 'americanfootball_nfl',    season: 'regular' },
  NHL:   { key: 'icehockey_nhl',           season: 'regular' },
  NCAAB: { key: 'basketball_ncaab',        season: 'regular' },
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
