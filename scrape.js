import { writeFile, readFile } from 'fs/promises';
import { scrapeKateAndToms } from './scrapers/kateandtoms.js';
import { scrapeGroupAccommodation } from './scrapers/groupaccommodation.js';
import { scrapeAirbnb } from './scrapers/airbnb.js';

const OUTPUT = 'properties.json';

// Load existing properties.json, keeping entries from sources not being re-scraped
async function loadExisting(excludeSources) {
  try {
    const raw = await readFile(OUTPUT, 'utf-8');
    const all = JSON.parse(raw);
    return all.filter(p => !excludeSources.includes(p.source));
  } catch {
    return [];
  }
}

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
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const onlySource = onlyArg ? onlyArg.split('=')[1].toLowerCase() : null;
  const scraperOptions = testMode ? { limit: 1 } : {};

  console.log('=== House Search Scraper ===\n');
  if (testMode) console.log('*** TEST MODE: 1 property per source ***\n');
  if (onlySource) console.log(`*** PARTIAL RUN: ${onlySource} only (preserving other sources) ***\n`);
  console.log('Criteria: Sleeps 20+, dog-friendly, entire property, 24-27 or 25-28 Sep 2026');
  console.log('Sources: Kate & Tom\'s, groupaccommodation.com, Airbnb\n');

  const startTime = Date.now();
  const errors = [];

  const allScrapers = [
    { name: "Kate & Tom's", key: 'kateandtoms', fn: scrapeKateAndToms },
    { name: 'groupaccommodation.com', key: 'groupaccommodation', fn: scrapeGroupAccommodation },
    { name: 'Airbnb', key: 'airbnb', fn: scrapeAirbnb },
  ];

  const scrapers = onlySource
    ? allScrapers.filter(s => s.key === onlySource || s.name.toLowerCase().includes(onlySource))
    : allScrapers;

  if (scrapers.length === 0) {
    console.error(`Unknown source: ${onlySource}. Valid options: kateandtoms, groupaccommodation, airbnb`);
    process.exit(1);
  }

  // Seed results with existing data from sources we're NOT re-scraping
  const existingOtherSources = onlySource ? await loadExisting(scrapers.map(s => s.key)) : [];
  if (existingOtherSources.length) {
    console.log(`[Load] Keeping ${existingOtherSources.length} existing properties from other sources\n`);
  }
  const results = [...existingOtherSources];

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
