const fs = require('fs');

const INPUT_FILE = './words_full.,txt';
const OUTPUT_FILE = './word_lookup.json';

const MIN_LEN = 3;
const MAX_LEN = 12;

function isValidWord(word) {
  if (!word || word.length < MIN_LEN || word.length > MAX_LEN) return false;
  if (!/^[a-z]+$/.test(word)) return false;
  if (word.includes('--')) return false;
  return true;
}

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

console.log('Reading word file...');
const content = fs.readFileSync(INPUT_FILE, 'utf8');
const lines = content.split('\n');

console.log(`Processing ${lines.length} lines...`);

const lookup = {};

let skipped = 0;
let added = 0;

for (const line of lines) {
  const word = line.trim().toLowerCase();

  if (!isValidWord(word)) {
    skipped++;
    continue;
  }

  const key = getSLKey(word);

  if (!lookup[key]) {
    lookup[key] = [];
  }

  if (!lookup[key].includes(word)) {
    lookup[key].push(word);
    added++;
  }
}

console.log(`Skipped: ${skipped}, Added: ${added} word entries`);

const keys = Object.keys(lookup).sort();
console.log(`Buckets created: ${keys.length}`);

const usedBuckets = keys.filter(k => lookup[k].length > 0);
console.log(`Buckets with words: ${usedBuckets.length}`);

for (const key of keys) {
  lookup[key].sort();
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(lookup, null, 2));
console.log(`Written to ${OUTPUT_FILE}`);

console.log('\nTop 10 buckets by word count:');
const sorted = keys
  .map(k => ({ key: k, count: lookup[k].length }))
  .sort((a, b) => b.count - a.count);

for (const { key, count } of sorted.slice(0, 10)) {
  console.log(`  ${key}: ${count} words`);
}

console.log('\nBuckets with 0 words (if any):');
const emptyCount = keys.filter(k => lookup[k].length === 0).length;
console.log(`  ${emptyCount} empty buckets`);

const sampleKeys = ['at', 'be', 'ing', 'tion', 'qy'];
console.log('\nSample lookups:');
for (const k of sampleKeys) {
  const words = lookup[k] || [];
  console.log(`  ${k}: ${words.slice(0, 5).join(', ')}${words.length > 5 ? '...' : ''} (${words.length})`);
}