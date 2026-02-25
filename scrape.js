import { writeFile } from 'fs/promises';
import { scrapeKateAndToms } from './scrapers/kateandtoms.js';
import { scrapeGroupAccommodation } from './scrapers/groupaccommodation.js';
import { scrapeAirbnb } from './scrapers/airbnb.js';

async function main() {
  console.log('=== House Search Scraper ===\n');
  console.log('Criteria: Sleeps 20+, dog-friendly, 24-27 or 25-28 Sep 2026');
  console.log('Sources: Kate & Tom\'s, groupaccommodation.com, Airbnb\n');

  const startTime = Date.now();

  const [ktResult, gaResult, airbnbResult] = await Promise.allSettled([
    scrapeKateAndToms(),
    scrapeGroupAccommodation(),
    scrapeAirbnb(),
  ]);

  const results = [];
  const errors = [];

  if (ktResult.status === 'fulfilled') {
    results.push(...ktResult.value);
    console.log(`\n✓ Kate & Tom's: ${ktResult.value.length} properties`);
  } else {
    errors.push(`Kate & Tom's: ${ktResult.reason?.message}`);
    console.error(`\n✗ Kate & Tom's failed: ${ktResult.reason?.message}`);
  }

  if (gaResult.status === 'fulfilled') {
    results.push(...gaResult.value);
    console.log(`✓ groupaccommodation.com: ${gaResult.value.length} properties`);
  } else {
    errors.push(`groupaccommodation.com: ${gaResult.reason?.message}`);
    console.error(`✗ groupaccommodation.com failed: ${gaResult.reason?.message}`);
  }

  if (airbnbResult.status === 'fulfilled') {
    results.push(...airbnbResult.value);
    console.log(`✓ Airbnb: ${airbnbResult.value.length} properties`);
  } else {
    errors.push(`Airbnb: ${airbnbResult.reason?.message}`);
    console.error(`✗ Airbnb failed: ${airbnbResult.reason?.message}`);
  }

  // Filter: must have coordinates (needed for map) and be in UK lat/lng range
  const before = results.length;
  const filtered = results.filter(p => {
    if (!p.lat || !p.lng) return false;
    // UK bounding box: lat 49-61, lng -8 to 2
    if (p.lat < 49 || p.lat > 61 || p.lng < -8 || p.lng > 2) return false;
    return true;
  });
  const dropped = before - filtered.length;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n=== Summary ===`);
  console.log(`Total scraped: ${before}, mappable (UK with coords): ${filtered.length}, dropped: ${dropped}`);
  console.log(`Time: ${elapsed}s`);
  if (errors.length) {
    console.log(`Errors: ${errors.length}`);
    errors.forEach(e => console.log(`  - ${e}`));
  }

  await writeFile('properties.json', JSON.stringify(filtered, null, 2));
  console.log('\nWrote properties.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
