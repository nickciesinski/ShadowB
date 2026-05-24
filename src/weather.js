'use strict';
// =============================================================
// src/weather.js — Game-day weather data from Open-Meteo
// Free API, no key needed, 10,000 calls/day limit.
// Provides wind speed, wind direction, temperature, and precip
// probability for MLB and NFL outdoor stadiums.
// =============================================================

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── Stadium coordinates and metadata ──
// Only outdoor (or retractable-roof) stadiums need weather data.
// Dome stadiums are excluded — weather doesn't affect them.
// Field orientation = degrees from home plate to center field (MLB)
// or from one end zone to the other (NFL).

const MLB_STADIUMS = {
  // team name (as used by Odds API) → { lat, lon, dome, fieldDir }
  // fieldDir: compass bearing from home plate toward center field
  'Arizona Diamondbacks':    { lat: 33.4455, lon: -112.0667, dome: true },
  'Atlanta Braves':          { lat: 33.8908, lon: -84.4678, dome: false, fieldDir: 170 },
  'Baltimore Orioles':       { lat: 39.2839, lon: -76.6216, dome: false, fieldDir: 338 },
  'Boston Red Sox':          { lat: 42.3467, lon: -71.0972, dome: false, fieldDir: 330 },
  'Chicago Cubs':            { lat: 41.9484, lon: -87.6553, dome: false, fieldDir: 350 },
  'Chicago White Sox':       { lat: 41.8299, lon: -87.6338, dome: false, fieldDir: 335 },
  'Cincinnati Reds':         { lat: 39.0974, lon: -84.5082, dome: false, fieldDir: 135 },
  'Cleveland Guardians':     { lat: 41.4962, lon: -81.6852, dome: false, fieldDir: 164 },
  'Colorado Rockies':        { lat: 39.7559, lon: -104.9942, dome: false, fieldDir: 20 },
  'Detroit Tigers':          { lat: 42.3390, lon: -83.0485, dome: false, fieldDir: 245 },
  'Houston Astros':          { lat: 29.7573, lon: -95.3555, dome: true },
  'Kansas City Royals':      { lat: 39.0517, lon: -94.4803, dome: false, fieldDir: 280 },
  'Los Angeles Angels':      { lat: 33.8003, lon: -117.8827, dome: false, fieldDir: 350 },
  'Los Angeles Dodgers':     { lat: 34.0739, lon: -118.2400, dome: false, fieldDir: 350 },
  'Miami Marlins':           { lat: 25.7781, lon: -80.2196, dome: true },
  'Milwaukee Brewers':       { lat: 43.0280, lon: -87.9712, dome: true },
  'Minnesota Twins':         { lat: 44.9817, lon: -93.2776, dome: false, fieldDir: 150 },
  'New York Mets':           { lat: 40.7571, lon: -73.8458, dome: false, fieldDir: 56 },
  'New York Yankees':        { lat: 40.8296, lon: -73.9262, dome: false, fieldDir: 62 },
  'Oakland Athletics':       { lat: 33.8010, lon: -116.5385, dome: false, fieldDir: 0 },  // Sacramento for 2025+
  'Philadelphia Phillies':   { lat: 39.9061, lon: -75.1665, dome: false, fieldDir: 15 },
  'Pittsburgh Pirates':      { lat: 40.4469, lon: -80.0057, dome: false, fieldDir: 40 },
  'San Diego Padres':        { lat: 32.7076, lon: -117.1570, dome: false, fieldDir: 340 },
  'San Francisco Giants':    { lat: 37.7786, lon: -122.3893, dome: false, fieldDir: 110 },
  'Seattle Mariners':        { lat: 47.5914, lon: -122.3325, dome: true },
  'St. Louis Cardinals':     { lat: 38.6226, lon: -90.1928, dome: false, fieldDir: 255 },
  'Tampa Bay Rays':          { lat: 27.7682, lon: -82.6534, dome: true },
  'Texas Rangers':           { lat: 32.7513, lon: -97.0825, dome: true },
  'Toronto Blue Jays':       { lat: 43.6414, lon: -79.3894, dome: true },
  'Washington Nationals':    { lat: 38.8730, lon: -77.0074, dome: false, fieldDir: 170 },
};

const NFL_STADIUMS = {
  'Arizona Cardinals':       { lat: 33.5276, lon: -112.2626, dome: true },
  'Atlanta Falcons':         { lat: 33.7554, lon: -84.4010, dome: true },
  'Baltimore Ravens':        { lat: 39.2780, lon: -76.6227, dome: false },
  'Buffalo Bills':           { lat: 42.7738, lon: -78.7870, dome: false },
  'Carolina Panthers':       { lat: 35.2258, lon: -80.8528, dome: false },
  'Chicago Bears':           { lat: 41.8623, lon: -87.6167, dome: false },
  'Cincinnati Bengals':      { lat: 39.0954, lon: -84.5160, dome: false },
  'Cleveland Browns':        { lat: 41.5061, lon: -81.6995, dome: false },
  'Dallas Cowboys':          { lat: 32.7473, lon: -97.0945, dome: true },
  'Denver Broncos':          { lat: 39.7439, lon: -105.0201, dome: false },
  'Detroit Lions':           { lat: 42.3400, lon: -83.0456, dome: true },
  'Green Bay Packers':       { lat: 44.5013, lon: -88.0622, dome: false },
  'Houston Texans':          { lat: 29.6847, lon: -95.4107, dome: true },
  'Indianapolis Colts':      { lat: 39.7601, lon: -86.1639, dome: true },
  'Jacksonville Jaguars':    { lat: 30.3239, lon: -81.6373, dome: false },
  'Kansas City Chiefs':      { lat: 39.0489, lon: -94.4839, dome: false },
  'Las Vegas Raiders':       { lat: 36.0909, lon: -115.1833, dome: true },
  'Los Angeles Chargers':    { lat: 33.9535, lon: -118.3390, dome: false },
  'Los Angeles Rams':        { lat: 33.9535, lon: -118.3390, dome: false },
  'Miami Dolphins':          { lat: 25.9580, lon: -80.2389, dome: false },
  'Minnesota Vikings':       { lat: 44.9736, lon: -93.2575, dome: true },
  'New England Patriots':    { lat: 42.0909, lon: -71.2643, dome: false },
  'New Orleans Saints':      { lat: 29.9511, lon: -90.0812, dome: true },
  'New York Giants':         { lat: 40.8128, lon: -74.0742, dome: false },
  'New York Jets':           { lat: 40.8128, lon: -74.0742, dome: false },
  'Philadelphia Eagles':     { lat: 39.9008, lon: -75.1675, dome: false },
  'Pittsburgh Steelers':     { lat: 40.4468, lon: -80.0158, dome: false },
  'San Francisco 49ers':     { lat: 37.4032, lon: -121.9698, dome: false },
  'Seattle Seahawks':        { lat: 47.5952, lon: -122.3316, dome: false },
  'Tampa Bay Buccaneers':    { lat: 27.9759, lon: -82.5033, dome: false },
  'Tennessee Titans':        { lat: 36.1665, lon: -86.7713, dome: false },
  'Washington Commanders':   { lat: 38.9076, lon: -76.8645, dome: false },
};

/**
 * Fetch weather data for a game from Open-Meteo.
 * @param {number} lat - Stadium latitude
 * @param {number} lon - Stadium longitude
 * @param {string} commenceTime - ISO 8601 game start time
 * @returns {Object|null} { temp_f, wind_mph, wind_dir, precip_pct } or null
 */
async function fetchGameWeather(lat, lon, commenceTime) {
  try {
    const gameDate = commenceTime.split('T')[0];
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,windspeed_10m,winddirection_10m,precipitation_probability&timezone=auto&start_date=${gameDate}&end_date=${gameDate}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.hourly || !data.hourly.time) return null;

    // Find the hour closest to game start
    const gameHour = new Date(commenceTime).getHours();
    // The API returns hours 0-23; pick the one matching game time
    const idx = Math.min(Math.max(gameHour, 0), data.hourly.time.length - 1);

    const tempC = data.hourly.temperature_2m?.[idx];
    const windKmh = data.hourly.windspeed_10m?.[idx];
    const windDir = data.hourly.winddirection_10m?.[idx];
    const precipPct = data.hourly.precipitation_probability?.[idx];

    return {
      temp_f: tempC != null ? Math.round(tempC * 9 / 5 + 32) : null,
      wind_mph: windKmh != null ? Math.round(windKmh * 0.621371) : null,
      wind_dir: windDir != null ? Math.round(windDir) : null,
      precip_pct: precipPct != null ? precipPct : null,
    };
  } catch (err) {
    console.warn(`[weather] Fetch failed for ${lat},${lon}: ${err.message}`);
    return null;
  }
}

/**
 * Compute wind impact for MLB based on wind direction relative to field orientation.
 * Wind blowing OUT to center field helps hitters (+ runs).
 * Wind blowing IN from center field suppresses offense (- runs).
 * Crosswinds have minimal effect.
 *
 * @param {number} windDir - Wind direction in degrees (where wind comes FROM)
 * @param {number} fieldDir - Compass bearing from home plate to center field
 * @param {number} windMph - Wind speed in mph
 * @returns {number} Impact factor: positive = boosts runs, negative = suppresses
 */
function mlbWindImpact(windDir, fieldDir, windMph) {
  if (windDir == null || fieldDir == null || windMph == null) return 0;
  if (windMph < 5) return 0; // Light wind has negligible effect

  // Wind comes FROM windDir. Wind blowing OUT means wind direction is
  // opposite to fieldDir (wind comes from behind home plate, blows toward CF).
  // The "blowing out" angle = fieldDir (i.e., wind FROM fieldDir - 180)
  const blowingOutFrom = ((fieldDir + 180) % 360);
  let angleDiff = Math.abs(windDir - blowingOutFrom);
  if (angleDiff > 180) angleDiff = 360 - angleDiff;

  // cos(angleDiff) = 1 when perfectly blowing out, -1 when blowing in
  const cosAngle = Math.cos(angleDiff * Math.PI / 180);

  // Scale: 15 mph wind blowing perfectly out ≈ +1.5 run impact
  // Roughly 0.1 runs per mph of effective outward wind component
  const effectiveWind = windMph * cosAngle;
  return effectiveWind * 0.1;
}

/**
 * Compute wind/weather impact for NFL.
 * High wind suppresses passing game → lower totals.
 * Cold temperature also slightly suppresses scoring.
 *
 * @param {number} windMph - Wind speed in mph
 * @param {number} tempF - Temperature in Fahrenheit
 * @returns {number} Impact on total (negative = suppresses scoring)
 */
function nflWeatherImpact(windMph, tempF) {
  let impact = 0;

  // Wind: >15 mph starts mattering, >25 mph is significant
  if (windMph != null && windMph > 15) {
    impact -= (windMph - 15) * 0.15; // ~1.5 pt reduction at 25 mph
  }

  // Cold: below 32°F starts affecting play
  if (tempF != null && tempF < 32) {
    impact -= (32 - tempF) * 0.05; // ~1 pt reduction at 12°F
  }

  return impact;
}

/**
 * Get weather data for all games in a league.
 * @param {Array} games - Array of game objects with { home, away, commence }
 * @param {string} league - 'MLB' or 'NFL'
 * @returns {Map} gameKey → { temp_f, wind_mph, wind_dir, precip_pct, impact }
 */
async function getGameWeather(games, league) {
  const stadiums = league === 'MLB' ? MLB_STADIUMS : league === 'NFL' ? NFL_STADIUMS : {};
  const results = new Map();

  // Batch fetch with small delays to respect rate limits
  for (const game of games) {
    const stadium = stadiums[game.home];
    if (!stadium) {
      console.log(`[weather] No stadium data for ${game.home} (${league})`);
      continue;
    }
    if (stadium.dome) {
      console.log(`[weather] ${game.home} plays in a dome — skipping`);
      results.set(`${game.away}@${game.home}`, { dome: true, impact: 0 });
      continue;
    }
    if (!game.commence) continue;

    const weather = await fetchGameWeather(stadium.lat, stadium.lon, game.commence);
    if (!weather) continue;

    let impact = 0;
    if (league === 'MLB' && stadium.fieldDir != null) {
      impact = mlbWindImpact(weather.wind_dir, stadium.fieldDir, weather.wind_mph);
    } else if (league === 'NFL') {
      impact = nflWeatherImpact(weather.wind_mph, weather.temp_f);
    }

    const key = `${game.away}@${game.home}`;
    results.set(key, { ...weather, impact, dome: false });
    console.log(`[weather] ${key}: ${weather.temp_f}°F, wind ${weather.wind_mph}mph @ ${weather.wind_dir}°, precip ${weather.precip_pct}%, impact ${impact.toFixed(2)}`);

    // Small delay between API calls
    await new Promise(r => setTimeout(r, 200));
  }

  return results;
}

module.exports = {
  MLB_STADIUMS,
  NFL_STADIUMS,
  fetchGameWeather,
  mlbWindImpact,
  nflWeatherImpact,
  getGameWeather,
};
