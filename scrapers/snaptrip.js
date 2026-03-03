import { launchBrowser, rateLimit, sleep } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';

const BASE = 'https://www.snaptrip.com';

const DATE_RANGES = [
  { checkIn: '24/09/2026', label: '24-27 Sep' },
  { checkIn: '25/09/2026', label: '25-28 Sep' },
];

export async function scrapeSnaptrip(options = {}) {
  console.log('[Snaptrip] Starting Snaptrip scraper...');
  const { browser, context } = await launchBrowser();

  try {
    // Phase 1: Create a search session for each date range, collect all properties
    const propertyMap = new Map(); // id -> { prop data, dates: [] }

    for (const range of DATE_RANGES) {
      const searchId = await createSearch(context, range.checkIn, range.label);
      if (!searchId) {
        console.warn(`[Snaptrip] Failed to create search for ${range.label}`);
        continue;
      }

      const props = await fetchAllPages(searchId, range.label, options.limit);
      for (const prop of props) {
        if (!propertyMap.has(prop.id)) {
          propertyMap.set(prop.id, { ...prop, dates: [] });
        }
        propertyMap.get(prop.id).dates.push(range.label);
      }
    }

    console.log(`[Snaptrip] Found ${propertyMap.size} unique properties across both date ranges`);

    // Phase 2: Fetch detail pages for games detection
    const results = [];
    const entries = [...propertyMap.values()];
    const toScrape = options.limit ? entries.slice(0, options.limit) : entries;

    for (const entry of toScrape) {
      try {
        await rateLimit();
        const games = await fetchGames(entry.link);
        const prop = {
          name: entry.name,
          sleeps: entry.sleeps,
          location: entry.town?.path || entry.town?.name || '',
          lat: entry.lat,
          lng: entry.lng,
          games,
          image: entry.images?.[0]?.url || null,
          url: BASE + entry.link,
          price: await fetchPrice(entry.id),
          rating: entry.total_reviews > 0 ? `${entry.total_reviews} reviews` : null,
          available_dates: entry.dates,
        };
        results.push(normalise(prop, 'snaptrip'));
      } catch (err) {
        console.error(`[Snaptrip] Error scraping ${entry.link}: ${err.message}`);
      }
    }

    console.log(`[Snaptrip] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function createSearch(context, checkIn, label) {
  const page = await context.newPage();
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1000);

    // Dismiss cookie banner if present
    await page.evaluate(() => {
      const ok = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
      if (ok) ok.click();
    });

    // Fill form fields directly (date input is hidden, must use JS)
    await page.evaluate((date) => {
      const q = n => document.querySelector(`[name="${n}"]`);
      if (q('search[region]')) q('search[region]').value = 'England';
      if (q('search[check_in_on]')) q('search[check_in_on]').value = date;
      if (q('search[minimum_nights]')) q('search[minimum_nights]').value = '3';
      if (q('search[sleeps]')) q('search[sleeps]').value = '20';
      if (q('search[pet_count]')) q('search[pet_count]').value = '1';
    }, checkIn);

    // Submit form and follow redirect
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      page.evaluate(() => document.querySelector('form').submit()),
    ]);

    const searchId = page.url().match(/\/searches\/(\d+)/)?.[1];
    console.log(`[Snaptrip] ${label} → search ID: ${searchId} (${page.url()})`);
    return searchId;
  } catch (err) {
    console.error(`[Snaptrip] Search creation failed for ${label}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function fetchAllPages(searchId, label, limit) {
  const allProps = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${BASE}/searches/${searchId}.json?page=${page}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`[Snaptrip] ${label} page ${page}: HTTP ${resp.status}`);
      break;
    }
    const data = await resp.json();

    totalPages = data.pagination?.total_pages || 1;
    const props = data.properties || [];

    console.log(`[Snaptrip] ${label} page ${page}/${totalPages}: ${props.length} properties (total: ${data.pagination?.total_count})`);

    for (const prop of props) {
      if (!allProps.find(p => p.id === prop.id)) {
        allProps.push(prop);
      }
    }

    if (limit && allProps.length >= limit) break;
    page++;
    await sleep(500);
  }

  return allProps;
}

async function fetchPrice(id) {
  try {
    const url = `${BASE}/api/v2/properties/${id}/liveprice?checkinDate=2026-09-24&nights=3`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data._data || data;
    const p = d.discount_price || d.original_price;
    return p ? `£${Number(p).toLocaleString('en-GB')}` : null;
  } catch {
    return null;
  }
}

async function fetchGames(link) {
  const games = [];
  try {
    const resp = await fetch(BASE + link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    if (!resp.ok) return games;

    const html = await resp.text();

    // Extract description paragraphs (SSR-encoded as HTML entities)
    const paraMatches = html.match(/&lt;p&gt;(.*?)&lt;\/p&gt;/gi) || [];
    const descText = paraMatches
      .map(p => p.replace(/&lt;[^&]+&gt;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' '))
      .join(' ')
      .toLowerCase();

    // Also use meta description
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
    const metaText = (metaMatch?.[1] || '').toLowerCase();

    const fullText = descText + ' ' + metaText;

    if (fullText.includes('table tennis') || fullText.includes('ping pong') || fullText.includes('ping-pong')) games.push('Table tennis');
    if (fullText.includes('snooker') || fullText.includes('billiard')) {
      const isFull = /full[\s-]?size[d]?\s+(?:snooker|billiard)/.test(fullText) || /(?:12[\s-]?f(?:oo)?t|tournament[\s-]?size[d]?|professional[\s-]?size[d]?)\s+(?:snooker|billiard)/.test(fullText);
      games.push(isFull ? 'Full-size snooker' : 'Snooker');
    }
    if (/\bpool table\b|table.*\bpool\b|\bpool\b.*table/.test(fullText)) games.push('Pool');
    if (fullText.includes('table football') || fullText.includes('foosball')) games.push('Table football');
    if (fullText.includes('darts') || fullText.includes('dartboard')) games.push('Darts');
    if (fullText.includes('air hockey')) games.push('Air hockey');
    if (fullText.includes('games console') || fullText.includes('playstation') || fullText.includes('xbox') || fullText.includes('nintendo')) games.push('Games console');
    if (fullText.includes('cinema') || fullText.includes('movie room') || fullText.includes('film room')) games.push('Cinema');
    if (fullText.includes('piano')) games.push('Piano');
    if (fullText.includes('hot tub')) games.push('Hot tub');
    if (fullText.includes('indoor pool') || fullText.includes('swimming pool')) games.push('Swimming pool');
    if (fullText.includes('sauna')) games.push('Sauna');
    if (fullText.includes('tennis court')) games.push('Tennis court');
    if (fullText.includes('games room') || fullText.includes('games/play')) games.push('Games room');
    if (fullText.includes('fire pit') || fullText.includes('fire-pit') || fullText.includes('firepit')) games.push('Fire pit');
  } catch (err) {
    // Non-fatal: return empty games
  }
  return games;
}
