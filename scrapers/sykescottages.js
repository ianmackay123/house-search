import { launchBrowser, rateLimit, sleep } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';

const BASE = 'https://www.sykescottages.co.uk';
const TIMEOUT = 20000;

const DATE_RANGES = [
  { start: '24%2F09%2F2026', label: '24-27 Sep' },
  { start: '25%2F09%2F2026', label: '25-28 Sep' },
];

export async function scrapeSykesCottages(options = {}) {
  console.log('[Sykes] Starting Sykes Cottages scraper...');
  const { browser, context } = await launchBrowser();

  try {
    // Phase 1: Collect property URLs from search results for both date ranges
    const propertyMap = new Map(); // url -> { url, dates[], price }

    for (const range of DATE_RANGES) {
      const urls = await searchDateRange(context, range, options.limit);
      console.log(`[Sykes] ${range.label}: found ${urls.length} property URLs`);
      for (const { url, price } of urls) {
        if (!propertyMap.has(url)) propertyMap.set(url, { url, price, dates: [] });
        else if (price && !propertyMap.get(url).price) propertyMap.get(url).price = price;
        propertyMap.get(url).dates.push(range.label);
      }
    }

    console.log(`[Sykes] ${propertyMap.size} unique properties to scrape`);

    // Phase 2: Fetch property detail pages (SSR — JSON-LD has all data)
    const results = [];
    const entries = [...propertyMap.values()];
    const toScrape = options.limit ? entries.slice(0, options.limit) : entries;

    for (const entry of toScrape) {
      try {
        await rateLimit();
        const prop = await fetchProperty(entry);
        if (prop) results.push(normalise(prop, 'sykescottages'));
      } catch (err) {
        console.error(`[Sykes] Error scraping ${entry.url}: ${err.message}`);
      }
    }

    console.log(`[Sykes] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function searchDateRange(context, range, limit) {
  const urls = [];
  let page = 1;

  while (true) {
    const url = `${BASE}/search.html?num_sleeps=20&pet_friendly=1&start=${range.start}&duration=3&page=${page}`;
    const browserPage = await context.newPage();
    try {
      await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      // Wait for JS to render property cards
      await browserPage.waitForSelector('.wrapper-property-primary, .property-primary, .no-results', { timeout: 12000 }).catch(() => {});
      await sleep(2000);

      const pageResults = await browserPage.evaluate((base) => {
        const results = [];
        const cards = document.querySelectorAll('.wrapper-property-primary');
        for (const card of cards) {
          const link = card.querySelector('a[href*="/cottage/"]');
          if (!link) continue;
          const href = link.getAttribute('href');
          const url = href.startsWith('http') ? href : base + href;
          // Price from card — shown as "from £X" or "£X for X nights"
          const priceEl = card.querySelector('[class*="price"], .price, .from-price, .property-price');
          const price = priceEl?.textContent?.trim().match(/£[\d,]+/)?.[0] || null;
          results.push({ url: url.split('?')[0], price });
        }
        return results;
      }, BASE);

      if (pageResults.length === 0) break;

      for (const r of pageResults) {
        if (!urls.find(u => u.url === r.url)) urls.push(r);
      }

      console.log(`[Sykes] ${range.label} page ${page}: ${pageResults.length} results (total: ${urls.length})`);

      if (limit && urls.length >= limit) break;

      // Check if there's a next page
      const hasNext = await browserPage.evaluate(() => {
        const next = document.querySelector('.pagination a[rel="next"], .pagination .next:not(.disabled), a[data-page]');
        return !!next;
      });
      if (!hasNext) break;
      page++;
    } catch (err) {
      console.error(`[Sykes] Search page ${page} for ${range.label} failed: ${err.message}`);
      break;
    } finally {
      await browserPage.close();
    }

    await rateLimit();
  }

  return urls;
}

async function fetchProperty(entry) {
  const resp = await fetch(entry.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
  });
  if (!resp.ok) return null;
  const html = await resp.text();

  // Extract JSON-LD
  const ldMatch = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
  if (!ldMatch) return null;

  let ld;
  try { ld = JSON.parse(ldMatch[1]); } catch { return null; }

  const place = ld.containsPlace || {};
  const sleeps = place.occupancy?.value || null;
  if (sleeps && sleeps < 20) return null;

  const name = ld.name || '';
  const lat = ld.latitude ? parseFloat(ld.latitude) : null;
  const lng = ld.longitude ? parseFloat(ld.longitude) : null;
  const location = ld.address?.streetAddress || '';
  const image = Array.isArray(ld.image) ? ld.image[0] : (ld.image || null);

  // Parse amenityFeature for games/features
  const amenities = (place.amenityFeature || [])
    .filter(f => f.value === true)
    .map(f => (f.name || '').toLowerCase());

  // Also scan description text
  const desc = (ld.description || '').toLowerCase();
  const fullText = amenities.join(' ') + ' ' + desc;

  const games = [];
  if (fullText.includes('table tennis') || fullText.includes('ping pong') || fullText.includes('ping-pong')) games.push('Table tennis');
  if (fullText.includes('snooker')) games.push('Snooker');
  if (/pool table|\btable.*pool\b|\bpool\b.*table/.test(fullText)) games.push('Pool');
  if (fullText.includes('table football') || fullText.includes('foosball')) games.push('Table football');
  if (fullText.includes('darts') || fullText.includes('dartboard')) games.push('Darts');
  if (fullText.includes('air hockey')) games.push('Air hockey');
  if (fullText.includes('games console') || fullText.includes('playstation') || fullText.includes('xbox') || fullText.includes('nintendo')) games.push('Games console');
  if (fullText.includes('cinema') || fullText.includes('movie room') || fullText.includes('film room')) games.push('Cinema');
  if (fullText.includes('piano')) games.push('Piano');
  if (fullText.includes('hot tub') || amenities.includes('hot_tub')) games.push('Hot tub');
  if (fullText.includes('swimming pool') || fullText.includes('indoor pool') || amenities.includes('swimming_pool')) games.push('Swimming pool');
  if (fullText.includes('tennis court')) games.push('Tennis court');
  if (fullText.includes('sauna')) games.push('Sauna');
  if (fullText.includes('games room') || fullText.includes('games barn') || fullText.includes('games/play')) games.push('Games room');
  if (fullText.includes('fire pit') || fullText.includes('fire-pit') || fullText.includes('firepit')) games.push('Fire pit');
  if (fullText.includes('open fire') || fullText.includes('fireplace') || amenities.includes('fireplace')) games.push('Open fire');

  return {
    name,
    sleeps,
    location,
    lat,
    lng,
    games,
    image,
    url: entry.url,
    price: entry.price,
    available_dates: entry.dates,
  };
}
