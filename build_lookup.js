const fs = require('fs');

// ── Configuration ────────────────────────────────────
const PRIMARY_FILE = './words_scowl70.txt';
const SLURS_FILE = './slurs_blacklist.txt';
const DEMONYMS_FILE = './demonyms.txt';
const OUTPUT_FILE = './word_lookup.json';

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

function loadDemonyms() {
  if (!fs.existsSync(DEMONYMS_FILE)) {
    console.log(`  No demonyms file found at ${DEMONYMS_FILE}, skipping demonyms`);
    return [];
  }
  const content = fs.readFileSync(DEMONYMS_FILE, 'utf8');
  const demonyms = content.split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .filter(w => /^[a-z]+$/.test(w))
    .filter(w => w.length >= MIN_LEN && w.length <= MAX_LEN);
  console.log(`  Loaded ${demonyms.length} demonyms from ${DEMONYMS_FILE}`);
  return demonyms;
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

// ── Phase 3: Demonyms ────────────────────────────────

console.log('\n═══ Phase 3: Curated Demonyms ═══');
const demonyms = loadDemonyms();

let demonymsAdded = 0;
let demonymsSkipped = 0;

for (const word of demonyms) {
  if (!isValidPrimary(word, slursBlacklist)) {
    demonymsSkipped++;
    continue;
  }
  if (addToLookup(lookup, word)) {
    demonymsAdded++;
  } else {
    demonymsSkipped++;
  }
}

console.log(`  Added: ${demonymsAdded}, Already present/skipped: ${demonymsSkipped}`);

// Show which demonyms are new
if (demonymsAdded > 0) {
  console.log(`  ${demonymsAdded} new demonyms added to dictionary`);
}

report(lookup, 'Final (SCOWL 70 + demonyms)');

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

// ── Demonym Validation ────────────────────────────────

console.log('\nDemonym presence check:');
const checkWords = ['american', 'arab', 'french', 'indian', 'texan', 'canadian', 
  'mexican', 'scottish', 'japanese', 'chinese', 'korean', 'russian', 'british',
  'swedish', 'spanish', 'italian', 'german', 'dutch', 'irish', 'jewish'];
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
console.log(`  Demonyms added: ${demonymsAdded}`);
