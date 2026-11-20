// Reads the Folkpaths rating from the official Tripadvisor Terra API and
// rewrites Folkpaths Website/data/ratings.json only when the rating or review
// count changed. Exits non-zero on a bad response so the old file stays live.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const locationId = '34112128';
const file = 'Folkpaths Website/data/ratings.json';
const key = process.env.TRIPADVISOR_API_KEY;

// Terra Location Details: https://docs.terra.tripadvisor.com/reference/locationget
const url = `https://terra.tripadvisor.com/api/locations/${locationId}?version=1&locale=en-US`;
const response = await fetch(url, { headers: { accept: 'application/json', 'x-api-key': key } });
if (!response.ok) {
  console.error(`Tripadvisor API returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  process.exit(1);
}

const details = await response.json();
const overall = details.traveler_ratings?.overall;
const value = Number(overall?.rating);
const count = Number(overall?.count);
if (!(value >= 1 && value <= 5) || !Number.isInteger(count) || count < 1) {
  console.error(`Unexpected rating data: ${JSON.stringify(details.traveler_ratings ?? null).slice(0, 300)}`);
  process.exit(1);
}

let current = {};
try {
  current = JSON.parse(await readFile(file, 'utf8'));
} catch {}

if (current.tripadvisor?.value === value && current.tripadvisor?.count === count) {
  console.log(`Unchanged: ${value}/5 from ${count} reviews.`);
  process.exit(0);
}

const updated = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
await mkdir('Folkpaths Website/data', { recursive: true });
await writeFile(file, `${JSON.stringify({ ...current, tripadvisor: { value, count, updated } }, null, 2)}\n`);
console.log(`Updated: ${value}/5 from ${count} reviews.`);
