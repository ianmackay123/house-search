import { launchBrowser, fetchPage, rateLimit } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';

const BASE = 'https://bighouseexperience.com';
const TIMEOUT = 15000;

const DATE_RANGES = [
  { date: '24/09/2026', label: '24-27 Sep' },
  { date: '25/09/2026', label: '25-28 Sep' },
];

export async function scrapeBigHouseExperience(options = {}) {
  console.log('[BHE] Starting Big House Experience scraper...');
  const { browser, context } = await launchBrowser({
    args: ['--ignore-certificate-errors'],
  });

  try {
    // Collect property URLs from search results for both date ranges
    const propertyMap = new Map(); // slug -> { url, dates: [] }

    for (const range of DATE_RANGES) {
      const searchUrl = `${BASE}/large-houses-to-rent?partysizemin=20&dogs=1&datefrom=${encodeURIComponent(range.date)}&nights=3`;
      const page = await context.newPage();
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForTimeout(1500);

        const cards = await page.evaluate((base) => {
          // Each SearchResults-item contains a carousel of images and a link
          const items = document.querySelectorAll('.SearchResults-item');
          const results = [];
          for (const item of items) {
            // Get the property link
            const link = item.querySelector('a[href*="/large-houses-to-rent/"]');
            if (!link) continue;
            const url = link.href.split('?')[0];
            if (!url.startsWith(base + '/large-houses-to-rent/') || url === base + '/large-houses-to-rent/') continue;
            // Get first carousel image (the exterior shot, no width=140 in src)
            const img = [...item.querySelectorAll('.SearchResults-carouselSlide img, img')]
              .find(i => {
                const s = i.getAttribute('src') || i.src || '';
                return s.includes('/media/') && !s.includes('width=140');
              });
            const rawSrc = img ? (img.getAttribute('src') || img.src) : null;
            const image = rawSrc ? (rawSrc.startsWith('http') ? rawSrc.split('?')[0] : base + rawSrc.split('?')[0]) : null;
            results.push({ url, image });
          }
          // Fallback: if no SearchResults-item structure, collect links without images
          if (results.length === 0) {
            const links = [...document.querySelectorAll('a[href*="/large-houses-to-rent/"]')]
              .map(a => a.href.split('?')[0])
              .filter(h => h.startsWith(base + '/large-houses-to-rent/') && h.length > (base + '/large-houses-to-rent/').length);
            return [...new Set(links)].map(url => ({ url, image: null }));
          }
          return results;
        }, BASE);

        console.log(`[BHE] ${range.label}: found ${cards.length} properties`);
        for (const { url, image } of cards) {
          if (!propertyMap.has(url)) propertyMap.set(url, { url, image, dates: [] });
          else if (image && !propertyMap.get(url).image) propertyMap.get(url).image = image;
          propertyMap.get(url).dates.push(range.label);
        }
      } catch (err) {
        console.error(`[BHE] Search failed for ${range.label}: ${err.message}`);
      } finally {
        await page.close();
      }
    }

    console.log(`[BHE] ${propertyMap.size} unique properties to scrape`);

    // Scrape each property detail page
    const results = [];
    const entries = [...propertyMap.values()];
    const toScrape = options.limit ? entries.slice(0, options.limit) : entries;

    for (const entry of toScrape) {
      try {
        await rateLimit();
        const prop = await scrapeProperty(context, entry);
        if (prop) results.push(normalise(prop, 'bighouseexperience'));
      } catch (err) {
        console.error(`[BHE] Error scraping ${entry.url}: ${err.message}`);
      }
    }

    console.log(`[BHE] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function scrapeProperty(context, entry) {
  const page = await context.newPage();
  try {
    await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1000);

    const details = await page.evaluate(() => {
      const name = document.querySelector('h1')?.textContent?.trim() || '';

      // Coordinates from data attributes
      const geoEl = document.querySelector('[data-lat]');
      const lat = geoEl ? parseFloat(geoEl.getAttribute('data-lat')) : null;
      const lng = geoEl ? parseFloat(geoEl.getAttribute('data-long') || geoEl.getAttribute('data-lng')) : null;

      // Location: extract from h1 "Name in Location" or find region text
      const locMatch = name.match(/\bin\s+(.+)$/i);
      const location = locMatch ? locMatch[1].trim() : (document.querySelector('[class*="region"],[class*="county"],[class*="location"]')?.textContent?.trim() || '');

      // Sleeps
      const allText = document.body.innerText;
      const sleepsMatch = allText.match(/[Ss]leeps\s+(\d+)/);
      const sleeps = sleepsMatch ? parseInt(sleepsMatch[1], 10) : null;

      // Price per night
      const priceMatch = allText.match(/from\s*£([\d,]+)\s*per\s*night/i) || allText.match(/£([\d,]+)\s*per\s*night/i);
      const price = priceMatch ? '£' + priceMatch[1] + ' per night' : null;

      // Image is provided from search results (detail pages don't have property-specific images)
      const imgSrc = null;

      // Amenities from page text
      const text = allText.toLowerCase();
      const games = [];
      if (text.includes('table tennis') || text.includes('ping pong') || text.includes('ping-pong')) games.push('Table tennis');
      if (text.includes('snooker')) games.push('Snooker');
      if (/pool table|\btable.*pool\b|\bpool\b.*table/.test(text)) games.push('Pool');
      if (text.includes('table football') || text.includes('foosball')) games.push('Table football');
      if (text.includes('darts') || text.includes('dartboard')) games.push('Darts');
      if (text.includes('air hockey')) games.push('Air hockey');
      if (text.includes('games console') || text.includes('playstation') || text.includes('xbox') || text.includes('nintendo')) games.push('Games console');
      if (text.includes('cinema') || text.includes('movie room') || text.includes('film room')) games.push('Cinema');
      if (text.includes('piano')) games.push('Piano');
      if (text.includes('hot tub')) games.push('Hot tub');
      if (text.includes('swimming pool') || text.includes('indoor pool')) games.push('Swimming pool');
      if (text.includes('tennis court')) games.push('Tennis court');
      if (text.includes('sauna')) games.push('Sauna');
      if (text.includes('games room')) games.push('Games room');

      return { name, lat, lng, location, sleeps, price, imgSrc, games };
    });

    if (!details.name) return null;
    if (details.sleeps && details.sleeps < 20) return null;

    // Use image from search results; fall back to detail page if somehow set
    const image = entry.image || (details.imgSrc
      ? (details.imgSrc.startsWith('http') ? details.imgSrc : BASE + details.imgSrc.split('?')[0])
      : null);

    return {
      name: details.name,
      sleeps: details.sleeps,
      location: details.location,
      lat: details.lat,
      lng: details.lng,
      games: details.games,
      image,
      url: entry.url,
      price: details.price,
      available_dates: entry.dates,
    };
  } finally {
    await page.close();
  }
}
