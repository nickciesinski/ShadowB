#!/usr/bin/env node
'use strict';
/**
 * scripts/injury-tuner.js — weekly, automatic tuning of the injury feature.
 *
 * For NBA, NFL and NHL: measures how well each rating formula's injury gap
 * explains results against the closing line, and promotes/demotes the
 * feature through the 3-week out-of-sample gate in src/injury-tuning.js.
 * When a league is PROMOTED the fitted weight is written to
 * config/model-params.<LEAGUE>.json (spread + moneyline injury_gap_diff);
 * when it is demoted the weight goes back to 0.
 *
 * Writes: config/injury-tuning.json, config/model-params.*.json (only on a
 * promote/refit/demote), weight-reviews/injury-tuning-<date>.json.
 * Emails a short summary every run.
 *
 * Usage: node scripts/injury-tuner.js [--dry-run] [--days 150]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const paramStore = require('../src/param-store');
const tuning = require('../src/injury-tuning');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DAYS = parseInt(args.find((_, i, a) => a[i - 1] === '--days') || '150', 10);
const LEAGUES = ['NBA', 'NFL', 'NHL'];
const STATE_PATH = path.join(__dirname, '..', 'config', 'injury-tuning.json');

function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function loadRows(sb, league, sinceISO) {
  const market = tuning.SPREAD_TARGET.has(league) ? 'spread' : 'moneyline';
  const perf = await pageAll(() => sb.from('performance_log')
    .select('game_date, home_team, away_team, pick, close_line, close_novig_prob, home_score, away_score')
    .eq('league', league).eq('market', market).eq('pick_regime', 'v2_clv')
    .gte('game_date', sinceISO).not('home_score', 'is', null)
    .order('game_date', { ascending: true }));
  // One pick per game (doubleheaders aside, later duplicates add nothing).
  const games = new Map();
  for (const r of perf) games.set(`${r.game_date}|${r.home_team}|${r.away_team}`, r);

  // Feature vector at lock time = the EARLIEST row written for that game.
  const feats = await pageAll(() => sb.from('prediction_features')
    .select('date, home_team, away_team, features, created_at')
    .eq('league', league).eq('market', 'spread').gte('date', sinceISO)
    .order('created_at', { ascending: true }));
  const byGame = new Map();
  for (const f of feats) {
    const k = `${f.date}|${f.home_team}|${f.away_team}`;
    if (!byGame.has(k)) byGame.set(k, f.features || {});
  }

  const rows = [];
  for (const [k, r] of games) {
    const row = tuning.gameRow(league, r, byGame.get(k));
    if (row) rows.push(row);
  }
  return rows;
}

// Win-probability change per goal at an even game, from the model's own curve.
function nhlProbPerGoal() {
  try {
    const { marginToSpreadCoverProb } = require('../src/market-pricing');
    if (typeof marginToSpreadCoverProb !== 'function') return null;
    const up = marginToSpreadCoverProb(0.1, 0, 'NHL');
    const dn = marginToSpreadCoverProb(-0.1, 0, 'NHL');
    return (up - dn) / 0.2;
  } catch (e) {
    return null;
  }
}

function setLeagueWeight(league, weight) {
  const p = paramStore.load(league);
  for (const market of ['spread', 'moneyline']) {
    if (p[market] && 'injury_gap_diff' in p[market]) p[market].injury_gap_diff = weight;
  }
  paramStore.save(league, p);
}

async function sendEmail(subject, text) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_RECIPIENTS } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !EMAIL_RECIPIENTS) return;
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: GMAIL_USER, to: EMAIL_RECIPIENTS, subject, text });
}

const PLAIN = {
  insufficient: 'not enough games yet — nothing changed',
  qualify: 'passed this week\'s test',
  miss: 'did not pass this week — streak reset',
  degrade: 'made recent results worse',
};

(async () => {
  const today = todayPT();
  const sb = db.getClient();
  if (!sb) throw new Error('Supabase not configured');
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const report = { date: today, dryRun: DRY_RUN, leagues: {} };
  const lines = [];
  let anyLive = false;

  for (const league of LEAGUES) {
    const rows = await loadRows(sb, league, since);
    const week = tuning.evaluateWeek(rows, today);
    const params = paramStore.load(league);
    const dampen = params.params?.param_auto_csv_dampen ?? 0.3;
    const weight = tuning.slopeToWeight(league, week.fullFit.b, dampen,
      league === 'NHL' ? nhlProbPerGoal() : null);
    const { state: next, event } = tuning.transition(state[league], week, weight, today);
    state[league] = next;
    report.leagues[league] = { games: rows.length, week, proposedWeight: weight, event, state: { ...next, history: undefined } };

    if (!DRY_RUN && ['promoted', 'refit', 'demoted'].includes(event)) {
      setLeagueWeight(league, next.weight);
      anyLive = true;
    }
    const unit = tuning.SPREAD_TARGET.has(league) ? 'pts' : 'win prob';
    lines.push(`${league}: ${PLAIN[week.verdict]} (${week.holdout.n} recent games with injuries, `
      + `holdout ${(week.holdout.lift * 100).toFixed(1)}%). Formula ${week.variant}, `
      + `${week.fullFit.b} ${unit} per unit. Status ${next.status}, streak ${next.streak}/${tuning.REQUIRED_STREAK}`
      + (event === 'promoted' ? ' — NOW LIVE' : event === 'demoted' ? ' — SWITCHED OFF' : ''));
    console.log(`[injury-tuner] ${lines[lines.length - 1]}`);
  }

  if (!DRY_RUN) fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  const outDir = path.join(__dirname, '..', 'weight-reviews');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `injury-tuning-${today}.json`), JSON.stringify(report, null, 2) + '\n');

  // GitHub Actions output: tells the workflow whether params changed.
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `params_changed=${anyLive}\n`);

  const subject = anyLive ? 'Injury tuner: model weights changed' : 'Injury tuner: weekly check';
  await sendEmail(subject, [
    'Weekly injury tuning (how much each injury is worth, learned from your results).', '',
    ...lines, '',
    'It goes live by itself after 3 passing weeks in a row, and switches off by itself after a bad week.',
  ].join('\n')).catch(e => console.warn('[injury-tuner] email failed:', e.message));
})().catch((e) => { console.error('[injury-tuner] failed:', e); process.exit(1); });
