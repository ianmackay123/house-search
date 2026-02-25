import { writeFile } from 'fs/promises';
import { scrapeKateAndToms } from './scrapers/kateandtoms.js';
import { scrapeGroupAccommodation } from './scrapers/groupaccommodation.js';
import { scrapeAirbnb } from './scrapers/airbnb.js';

const OUTPUT = 'properties.json';

function filterUK(properties) {
  return properties.filter(p => {
    if (!p.lat || !p.lng) return false;
    // UK bounding box: lat 49-61, lng -8 to 2
    return p.lat >= 49 && p.lat <= 61 && p.lng >= -8 && p.lng <= 2;
  });
}

async function saveResults(results) {
  const filtered = filterUK(results);
  await writeFile(OUTPUT, JSON.stringify(filtered, null, 2));
  console.log(`[Save] Wrote ${filtered.length} mappable properties to ${OUTPUT}`);
}

async function main() {
  const testMode = process.argv.includes('--test');
  const scraperOptions = testMode ? { limit: 1 } : {};

  console.log('=== House Search Scraper ===\n');
  if (testMode) console.log('*** TEST MODE: 1 property per source ***\n');
  console.log('Criteria: Sleeps 20+, dog-friendly, entire property, 24-27 or 25-28 Sep 2026');
  console.log('Sources: Kate & Tom\'s, groupaccommodation.com, Airbnb\n');

  const startTime = Date.now();
  const results = [];
  const errors = [];

  // Run all 3 scrapers concurrently, save incrementally as each completes
  const scrapers = [
    { name: "Kate & Tom's", fn: scrapeKateAndToms },
    { name: 'groupaccommodation.com', fn: scrapeGroupAccommodation },
    { name: 'Airbnb', fn: scrapeAirbnb },
  ];

  const promises = scrapers.map(async ({ name, fn }) => {
    try {
      const props = await fn(scraperOptions);
      results.push(...props);
      console.log(`\n✓ ${name}: ${props.length} properties`);
      await saveResults(results);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      console.error(`\n✗ ${name} failed: ${err.message}`);
    }
  });

  await Promise.allSettled(promises);

  const filtered = filterUK(results);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n=== Summary ===`);
  console.log(`Total scraped: ${results.length}, mappable (UK with coords): ${filtered.length}, dropped: ${results.length - filtered.length}`);
  console.log(`Time: ${elapsed}s`);
  if (errors.length) {
    console.log(`Errors: ${errors.length}`);
    errors.forEach(e => console.log(`  - ${e}`));
  }

  // Final save
  await saveResults(results);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
