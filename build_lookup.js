const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// ── Configuration ────────────────────────────────────
const PRIMARY_FILE = './words_scowl70.txt';
const SLURS_FILE = './slurs_blacklist.txt';
const COUNTRIES_FILE = './countries.txt';
const STATES_FILE = './us_states.txt';
const CITIES_FILE = './us_cities.txt';
const OUTPUT_FILE = './word_lookup.json';

const POS_FILE = './part-of-speech.txt';
const POS_URL = 'https://raw.githubusercontent.com/en-wl/wordlist/master/pos/part-of-speech.txt';
const CATEGORIES_FILE = './word_categories.json';

const MIN_LEN = 3;
const MAX_LEN = 12;

// ── Helpers ──────────────────────────────────────────

function getSLKey(word) {
  const start = word[0];
  const end = word[word.length - 1];

  if (start === 'q' && end === 'y') {
    if (word.startsWith('qu')) {
      return 'qy';
    }
  }

  return start + end;
}

function loadSlursBlacklist() {
  if (!fs.existsSync(SLURS_FILE)) {
    console.log(`  No slurs file found at ${SLURS_FILE}, skipping blacklist`);
    return new Set();
  }
  const content = fs.readFileSync(SLURS_FILE, 'utf8');
  const slurs = content.split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length > 0 && !l.startsWith('#'));
  console.log(`  Loaded ${slurs.length} slur entries from ${SLURS_FILE}`);
  return new Set(slurs);
}

function loadCountries() {
  if (!fs.existsSync(COUNTRIES_FILE)) {
    console.log(`  No countries file found at ${COUNTRIES_FILE}, skipping countries`);
    return [];
  }
  const content = fs.readFileSync(COUNTRIES_FILE, 'utf8');
  const countries = content.split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .filter(w => /^[a-z]+$/.test(w))
    .filter(w => w.length >= MIN_LEN && w.length <= MAX_LEN);
  console.log(`  Loaded ${countries.length} countries from ${COUNTRIES_FILE}`);
  return countries;
}

function loadUSStates() {
  if (!fs.existsSync(STATES_FILE)) {
    console.log(`  No states file found at ${STATES_FILE}, skipping US states`);
    return [];
  }
  const content = fs.readFileSync(STATES_FILE, 'utf8');
  const states = content.split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .filter(w => /^[a-z]+$/.test(w))
    .filter(w => w.length >= MIN_LEN && w.length <= MAX_LEN);
  console.log(`  Loaded ${states.length} US states from ${STATES_FILE}`);
  return states;
}

function loadUSCities() {
  if (!fs.existsSync(CITIES_FILE)) {
    console.log(`  No cities file found at ${CITIES_FILE}, skipping US cities`);
    return [];
  }
  const content = fs.readFileSync(CITIES_FILE, 'utf8');
  const cities = content.split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .filter(w => /^[a-z]+$/.test(w))
    .filter(w => w.length >= MIN_LEN && w.length <= MAX_LEN);
  console.log(`  Loaded ${cities.length} US cities from ${CITIES_FILE}`);
  return cities;
}

function downloadPOSFile() {
  if (fs.existsSync(POS_FILE)) {
    const stat = fs.statSync(POS_FILE);
    console.log(`  Using cached ${POS_FILE} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
    return;
  }
  console.log(`  Downloading POS file from ${POS_URL}...`);
  try {
    execSync(`curl -fsSL -o "${POS_FILE}" "${POS_URL}"`, { stdio: 'inherit' });
  } catch (err) {
    // Fallback to Node's https module if curl fails
    console.log('  curl failed, falling back to https module...');
    const file = fs.createWriteStream(POS_FILE);
    https.get(POS_URL, (response) => {
      if (response.statusCode !== 200) {
        throw new Error(`Failed to download: HTTP ${response.statusCode}`);
      }
      response.pipe(file);
      file.on('finish', () => file.close());
    }).on('error', (err) => {
      fs.unlink(POS_FILE, () => {});
      throw err;
    });
    // Wait for the download to complete (simple sync wrapper)
    const startTime = Date.now();
    while (!file.closed && Date.now() - startTime < 60000) {
      require('child_process').execSync('sleep 0.1');
    }
  }
  console.log(`  Saved to ${POS_FILE}`);
}

function loadPOSTags() {
  const content = fs.readFileSync(POS_FILE, 'utf8');
  const lines = content.split('\n');
  const posMap = new Map();
  let parsed = 0;
  let skippedNonAlpha = 0;
  let skippedLength = 0;

  for (const line of lines) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) continue;

    const word = line.substring(0, tabIdx).toLowerCase();
    const tags = line.substring(tabIdx + 1);

    if (!/^[a-z]+$/.test(word)) {
      skippedNonAlpha++;
      continue;
    }
    if (word.length < MIN_LEN || word.length > MAX_LEN) {
      skippedLength++;
      continue;
    }

    // Strip '|' separators (WordNet source markers); keep tag letters
    const tagSet = new Set();
    for (const c of tags) {
      if (c === '|') continue;
      tagSet.add(c);
    }

    const existing = posMap.get(word);
    if (existing) {
      for (const c of tagSet) existing.add(c);
    } else {
      posMap.set(word, tagSet);
    }
    parsed++;
  }

  console.log(`  Parsed ${parsed.toLocaleString()} word entries (skipped ${skippedNonAlpha} non-alpha, ${skippedLength} length)`);
  console.log(`  Unique words in POS map: ${posMap.size.toLocaleString()}`);
  return posMap;
}

function computeCategories(lookup, posMap, countries, states, cities) {
  const countrySet = new Set(countries);
  const stateSet = new Set(states);
  const citySet = new Set(cities);
  const wordCategories = {};
  const categoryCounts = {};
  let tagged = 0;
  let untagged = 0;

  for (const words of Object.values(lookup)) {
    for (const word of words) {
      const cats = new Set();
      const tags = posMap.get(word);

      if (tags) {
        // Combined POS: noun (N/h/p), verb (V/t/i), adjective (A), adverb (v standalone)
        // All mapped to a single noun_adj_verb category.
        if (tags.has('N') || tags.has('h') || tags.has('p') ||
            tags.has('V') || tags.has('t') || tags.has('i') ||
            tags.has('A') ||
            (tags.has('v') && !tags.has('V') && !tags.has('t') && !tags.has('i'))) {
          cats.add('noun_adj_verb');
        }
        // preposition: P (treated uniformly, simplifying Moby Plural vs WordNet Preposition)
        if (tags.has('P')) cats.add('preposition');
      }

      // countries: word appears in countries list (additive to POS tags)
      if (countrySet.has(word)) cats.add('countries');
      // us_states: word appears in US states list (additive)
      if (stateSet.has(word)) cats.add('us_states');
      // us_cities: word appears in US cities list (additive)
      if (citySet.has(word)) cats.add('us_cities');

      const sortedCats = Array.from(cats).sort();
      wordCategories[word] = sortedCats;

      if (sortedCats.length === 0) {
        untagged++;
      } else {
        tagged++;
        for (const c of sortedCats) {
          categoryCounts[c] = (categoryCounts[c] || 0) + 1;
        }
      }
    }
  }

  return { wordCategories, tagged, untagged, categoryCounts };
}

function isValidPrimary(word, slursBlacklist) {
  if (!word || word.length < MIN_LEN || word.length > MAX_LEN) return false;
  if (!/^[a-z]+$/.test(word)) return false;
  if (word.includes('--')) return false;
  if (slursBlacklist.has(word)) return false;
  return true;
}

function addToLookup(lookup, word) {
  const key = getSLKey(word);
  if (!lookup[key]) {
    lookup[key] = [];
  }
  if (!lookup[key].includes(word)) {
    lookup[key].push(word);
    return true;
  }
  return false;
}

function report(lookup, label) {
  const keys = Object.keys(lookup).sort();
  const total = keys.reduce((s, k) => s + lookup[k].length, 0);
  const used = keys.filter(k => lookup[k].length > 0);

  const allLetters = 'abcdefghijklmnopqrstuvwxyz';
  const allPairs = [];
  for (const s of allLetters) for (const e of allLetters) allPairs.push(s + e);
  const empty = allPairs.filter(p => !lookup[p] || lookup[p].length === 0);
  const lowCoverage = allPairs.filter(p => lookup[p] && lookup[p].length > 0 && lookup[p].length < 5);

  console.log(`\n=== ${label} ===`);
  console.log(`  Total word entries: ${total.toLocaleString()}`);
  console.log(`  Active buckets: ${used.length}/676`);
  console.log(`  Empty buckets (0 words): ${empty.length}`);
  console.log(`  Low coverage (<5 words): ${lowCoverage.length}`);
}

// ── Phase 1: Load Blacklist ──────────────────────────

console.log('═══ Phase 1: Load Blacklist ═══');
const slursBlacklist = loadSlursBlacklist();

// ── Phase 2: Primary Source (SCOWL 70) ───────────────

console.log('\n═══ Phase 2: Primary Source (SCOWL 70) ═══');
console.log(`Reading ${PRIMARY_FILE}...`);
const primaryContent = fs.readFileSync(PRIMARY_FILE, 'utf8');
const primaryLines = primaryContent.split('\n');
console.log(`  ${primaryLines.length} raw lines`);

const lookup = {};

let primarySkipped = 0;
let primaryAdded = 0;
let slursFiltered = 0;

for (const line of primaryLines) {
  const word = line.trim().toLowerCase();
  if (slursBlacklist.has(word)) {
    slursFiltered++;
    continue;
  }
  if (!isValidPrimary(word, slursBlacklist)) {
    primarySkipped++;
    continue;
  }
  if (addToLookup(lookup, word)) {
    primaryAdded++;
  }
}

console.log(`  Skipped: ${primarySkipped}, Added: ${primaryAdded}, Slurs filtered: ${slursFiltered}`);
report(lookup, 'After SCOWL 70 (+ blacklist)');

// ── Phase 3: Countries ────────────────────────────────

console.log('\n═══ Phase 3: Curated Countries ═══');
const countries = loadCountries();

let countriesAdded = 0;
let countriesSkipped = 0;

for (const word of countries) {
  if (!isValidPrimary(word, slursBlacklist)) {
    countriesSkipped++;
    continue;
  }
  if (addToLookup(lookup, word)) {
    countriesAdded++;
  } else {
    countriesSkipped++;
  }
}

console.log(`  Added: ${countriesAdded}, Already present/skipped: ${countriesSkipped}`);

// Show which countries are new
if (countriesAdded > 0) {
  console.log(`  ${countriesAdded} new countries added to dictionary`);
}

report(lookup, 'Final (SCOWL 70 + countries)');

// ── Phase 4: US States ───────────────────────────────

console.log('\n═══ Phase 4: Curated US States ═══');
const states = loadUSStates();

let statesAdded = 0;
let statesSkipped = 0;

for (const word of states) {
  if (!isValidPrimary(word, slursBlacklist)) {
    statesSkipped++;
    continue;
  }
  if (addToLookup(lookup, word)) {
    statesAdded++;
  } else {
    statesSkipped++;
  }
}

console.log(`  Added: ${statesAdded}, Already present/skipped: ${statesSkipped}`);

if (statesAdded > 0) {
  console.log(`  ${statesAdded} new US states added to dictionary`);
}

report(lookup, 'After US States');

// ── Phase 5: US Cities ───────────────────────────────

console.log('\n═══ Phase 5: Curated US Cities ═══');
const cities = loadUSCities();

let citiesAdded = 0;
let citiesSkipped = 0;

for (const word of cities) {
  if (!isValidPrimary(word, slursBlacklist)) {
    citiesSkipped++;
    continue;
  }
  if (addToLookup(lookup, word)) {
    citiesAdded++;
  } else {
    citiesSkipped++;
  }
}

console.log(`  Added: ${citiesAdded}, Already present/skipped: ${citiesSkipped}`);

if (citiesAdded > 0) {
  console.log(`  ${citiesAdded} new US cities added to dictionary`);
}

report(lookup, 'After US Cities');

// ── Phase 6: POS Categories ──────────────────────────

console.log('\n═══ Phase 6: POS Categories ═══');
console.log('Downloading/loading POS data...');
downloadPOSFile();
const posMap = loadPOSTags();

console.log('\nComputing word categories...');
const { wordCategories, tagged, untagged, categoryCounts } =
  computeCategories(lookup, posMap, countries, states, cities);

// Validate: every word in lookup must have an entry in wordCategories
let allLookupWords = new Set();
for (const words of Object.values(lookup)) {
  for (const w of words) allLookupWords.add(w);
}
let missing = 0;
for (const w of allLookupWords) {
  if (!(w in wordCategories)) {
    missing++;
    if (missing <= 5) console.log(`  MISSING: ${w}`);
  }
}
if (missing === 0) {
  console.log(`  ✓ All ${allLookupWords.size.toLocaleString()} lookup words have category entries`);
} else {
  throw new Error(`Coverage check failed: ${missing} words missing from word_categories`);
}

// Write word_categories.json (sorted keys, sorted arrays, 2-space indent)
const sortedCategoryKeys = Object.keys(wordCategories).sort();
const sortedCategories = {};
for (const k of sortedCategoryKeys) {
  sortedCategories[k] = wordCategories[k];
}

fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(sortedCategories, null, 2));
console.log(`\nWritten to ${CATEGORIES_FILE}`);

// Category breakdown
console.log('\nCategory breakdown:');
const sortedCats = Object.keys(categoryCounts).sort();
for (const c of sortedCats) {
  console.log(`  ${c}: ${categoryCounts[c].toLocaleString()} words`);
}
console.log(`  (untagged): ${untagged.toLocaleString()} words`);
console.log(`  ──`);
console.log(`  tagged: ${tagged.toLocaleString()}`);
console.log(`  untagged: ${untagged.toLocaleString()}`);
console.log(`  total: ${(tagged + untagged).toLocaleString()}`);

// Sample category lookups
console.log('\nSample category entries:');
const samples = ['about', 'book', 'run', 'good', 'fast', 'small', 'france', 'japan', 'canada', 'abaya',
  'texas', 'california', 'ohio', 'hawaii', 'chicago', 'phoenix', 'seattle', 'denver', 'miami'];
for (const w of samples) {
  if (w in sortedCategories) {
    console.log(`  ${w}: [${sortedCategories[w].join(', ')}]`);
  }
}

// ── Sort and Write ───────────────────────────────────

console.log('\n═══ Writing Output ═══');

const sortedKeys = Object.keys(lookup).sort();
for (const key of sortedKeys) {
  lookup[key].sort();
}

const sortedLookup = {};
for (const key of sortedKeys) {
  sortedLookup[key] = lookup[key];
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sortedLookup, null, 2));
console.log(`Written to ${OUTPUT_FILE}`);

// ── Bucket Stats ─────────────────────────────────────

const allLetters = 'abcdefghijklmnopqrstuvwxyz';
const allPairs = [];
for (const s of allLetters) for (const e of allLetters) allPairs.push(s + e);

function showTopBuckets(lookup) {
  const keys = Object.keys(lookup).sort((a, b) => lookup[b].length - lookup[a].length);
  console.log('\nTop 10 buckets:');
  for (const k of keys.slice(0, 10)) {
    console.log(`  ${k}: ${lookup[k].length} words`);
  }
}

function showEmptyBuckets(lookup) {
  const empty = allPairs.filter(p => !lookup[p] || lookup[p].length === 0);
  if (empty.length > 0) {
    console.log(`\nEmpty buckets (${empty.length}): ${empty.join(', ')}`);
  } else {
    console.log('\nNo empty buckets remain!');
  }
}

showTopBuckets(lookup);
showEmptyBuckets(lookup);

// ── Sample Validation ────────────────────────────────

console.log('\nSample lookups:');
const sampleKeys = ['at', 'be', 'ig', 'tn', 'qy', 'an', 'fn', 'rn', 'in'];
for (const k of sampleKeys) {
  const words = lookup[k] || [];
  const display = words.length > 0
    ? words.slice(0, 8).join(', ') + (words.length > 8 ? `... (+${words.length - 8})` : '')
    : '(empty)';
  console.log(`  ${k}: ${display} (${words.length} words)`);
}

// ── Country Validation ────────────────────────────────

console.log('\nCountry presence check:');
const checkWords = ['france', 'japan', 'canada', 'brazil', 'germany', 'mexico',
  'india', 'china', 'italy', 'spain', 'russia', 'egypt',
  'kenya', 'australia', 'norway', 'vietnam', 'chile', 'iran']; 
const lookupSet = new Set();
for (const [k, words] of Object.entries(lookup)) for (const w of words) lookupSet.add(w);
for (const w of checkWords) {
  const present = lookupSet.has(w);
  console.log(`  ${present ? '✓' : '✗'} ${w}`);
}

// ── Slur Validation ──────────────────────────────────

console.log('\nSlur absence check:');
const checkSlurs = ['chink', 'fag', 'faggot', 'kike', 'niggaz', 'nigger', 'spic', 'wetback', 'nigga'];
let slursFound = 0;
for (const s of checkSlurs) {
  if (lookupSet.has(s)) {
    console.log(`  ✗ FAIL: ${s} still in lookup!`);
    slursFound++;
  }
}
if (slursFound === 0) console.log(`  ✓ All ${checkSlurs.length} slur checks passed (none found)`);

// ── Summary ──────────────────────────────────────────

const finalKeys = Object.keys(lookup).sort();
const finalTotal = finalKeys.reduce((s, k) => s + lookup[k].length, 0);
const finalEmpty = allPairs.filter(p => !lookup[p] || lookup[p].length === 0);

console.log('\n═══ BUILD SUMMARY ═══');
console.log(`  Total words: ${finalTotal.toLocaleString()}`);
console.log(`  Active buckets: ${finalKeys.length}/676`);
console.log(`  Empty buckets: ${finalEmpty.length}`);
console.log(`  Slurs filtered: ${slursFiltered}`);
  console.log(`  Countries added: ${countriesAdded}`);
console.log(`  US states added: ${statesAdded}`);
console.log(`  US cities added: ${citiesAdded}`);
