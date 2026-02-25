import { scrapeAirbnb } from './scrapers/airbnb.js';

const results = await scrapeAirbnb();
console.log('\nFinal results:');
results.forEach(p => console.log(`  ${p.name} | sleeps: ${p.sleeps} | ${p.lat},${p.lng}`));
console.log('\nTotal:', results.length);
