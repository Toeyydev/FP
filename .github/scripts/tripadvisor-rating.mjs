// Reads the Folkpaths rating from the official Tripadvisor Content API and
// rewrites Folkpaths Website/data/ratings.json only when the rating or review
// count changed. Exits non-zero on a bad response so the old file stays live.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const locationId = '34112128';
const file = 'Folkpaths Website/data/ratings.json';
const key = process.env.TRIPADVISOR_API_KEY;

const url = `https://api.content.tripadvisor.com/api/v1/location/${locationId}/details?key=${encodeURIComponent(key)}&language=en`;
const response = await fetch(url, { headers: { accept: 'application/json', referer: 'https://folkpaths.com/' } });
if (!response.ok) {
  console.error(`Tripadvisor API returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  process.exit(1);
}

const details = await response.json();
const value = Number(details.rating);
const count = Number.parseInt(details.num_reviews, 10);
if (!(value >= 1 && value <= 5) || !(count > 0)) {
  console.error(`Unexpected rating data: rating=${details.rating} num_reviews=${details.num_reviews}`);
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
