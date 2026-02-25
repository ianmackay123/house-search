import { launchBrowser, rateLimit, sleep } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';

const DATE_RANGES = [
  { checkin: '2026-09-24', checkout: '2026-09-27', label: '24-27 Sep' },
  { checkin: '2026-09-25', checkout: '2026-09-28', label: '25-28 Sep' },
];

export async function scrapeAirbnb() {
  console.log('[Airbnb] Starting Airbnb scraper...');
  const { browser, context } = await launchBrowser();
  const allProperties = new Map(); // key by URL for deduplication

  try {
    for (const range of DATE_RANGES) {
      console.log(`[Airbnb] Searching ${range.label}...`);
      try {
        const properties = await searchDateRange(context, range);
        console.log(`[Airbnb] Found ${properties.length} properties for ${range.label}`);

        for (const prop of properties) {
          const existing = allProperties.get(prop.url);
          if (existing) {
            // Merge available dates
            if (!existing.available_dates.includes(range.label)) {
              existing.available_dates.push(range.label);
            }
          } else {
            prop.available_dates = [range.label];
            allProperties.set(prop.url, prop);
          }
        }
      } catch (err) {
        console.error(`[Airbnb] Error searching ${range.label}: ${err.message}`);
      }

      await rateLimit();
    }

    const results = [...allProperties.values()].map(p => normalise(p, 'airbnb'));
    console.log(`[Airbnb] Total unique properties: ${results.length}`);
    return results;
  } finally {
    await browser.close();
  }
}

async function searchDateRange(context, range) {
  const url = `https://www.airbnb.co.uk/s/England/homes?adults=20&checkin=${range.checkin}&checkout=${range.checkout}&pets=1&price_max=6000&l2_property_type_ids%5B%5D=1`;
  const page = await context.newPage();
  const allProperties = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for listings to appear
    await page.waitForSelector('[itemprop="itemListElement"], [data-testid="card-container"], [class*="listing"]', { timeout: 15000 }).catch(() => {});

    // Give extra time for dynamic content
    await sleep(3000);

    let pageNum = 1;
    while (true) {
      console.log(`[Airbnb] Processing page ${pageNum} for ${range.label}...`);

      const properties = await extractProperties(page);
      allProperties.push(...properties);

      // Try to get coordinates from deferred state data
      const coords = await extractCoordinates(page);
      // Match coordinates to properties by index if possible
      if (coords.length > 0) {
        const startIdx = allProperties.length - properties.length;
        for (let i = 0; i < properties.length && i < coords.length; i++) {
          if (coords[i]) {
            allProperties[startIdx + i].lat = coords[i].lat;
            allProperties[startIdx + i].lng = coords[i].lng;
          }
        }
      }

      // Check for next page
      const hasNext = await page.evaluate(() => {
        const nextBtn = document.querySelector('a[aria-label="Next"], nav[aria-label*="pagination"] a:last-child');
        if (nextBtn && !nextBtn.hasAttribute('disabled') && nextBtn.getAttribute('aria-disabled') !== 'true') {
          return nextBtn.href || true;
        }
        return false;
      });

      if (!hasNext || pageNum >= 3) break;

      // Click next page
      await page.evaluate(() => {
        const nextBtn = document.querySelector('a[aria-label="Next"], nav[aria-label*="pagination"] a:last-child');
        if (nextBtn) nextBtn.click();
      });
      pageNum++;
      await sleep(3000);
      await page.waitForSelector('[itemprop="itemListElement"], [data-testid="card-container"]', { timeout: 10000 }).catch(() => {});
    }
  } finally {
    await page.close();
  }

  return allProperties;
}

async function extractProperties(page) {
  return page.evaluate(() => {
    const results = [];

    // Try structured data first
    const listItems = document.querySelectorAll('[itemprop="itemListElement"]');
    if (listItems.length > 0) {
      for (const item of listItems) {
        const link = item.querySelector('a[href*="/rooms/"]');
        const nameEl = item.querySelector('[id^="title_"]') || item.querySelector('div[data-testid="listing-card-title"]') || item.querySelector('span[style*="font-weight"]');
        const priceEl = item.querySelector('span._1y74zjx, ._tyxjp1, [class*="price"]');
        const imgEl = item.querySelector('img');

        if (!link) continue;

        const href = link.href;
        const roomMatch = href.match(/\/rooms\/(\d+)/);
        const url = roomMatch ? `https://www.airbnb.co.uk/rooms/${roomMatch[1]}` : href.split('?')[0];

        results.push({
          name: nameEl?.textContent?.trim() || 'Airbnb Property',
          url,
          price: priceEl?.textContent?.trim() || null,
          image: imgEl?.src || null,
          location: 'England',
          lat: null,
          lng: null,
          games: [],
          sleeps: 20,
          available_dates: [],
        });
      }
      return results;
    }

    // Fallback: try card containers
    const cards = document.querySelectorAll('[data-testid="card-container"], .g1qv1ctd');
    for (const card of cards) {
      const link = card.querySelector('a[href*="/rooms/"]');
      if (!link) continue;

      const href = link.href;
      const roomMatch = href.match(/\/rooms\/(\d+)/);
      const url = roomMatch ? `https://www.airbnb.co.uk/rooms/${roomMatch[1]}` : href.split('?')[0];

      const nameEl = card.querySelector('[id^="title_"]') || card.querySelector('div[data-testid="listing-card-title"]');
      const priceEl = card.querySelector('[class*="price"], span._1y74zjx');
      const imgEl = card.querySelector('img');

      results.push({
        name: nameEl?.textContent?.trim() || 'Airbnb Property',
        url,
        price: priceEl?.textContent?.trim() || null,
        image: imgEl?.src || null,
        location: 'England',
        lat: null,
        lng: null,
        games: [],
        sleeps: 20,
        available_dates: [],
      });
    }

    return results;
  });
}

async function extractCoordinates(page) {
  return page.evaluate(() => {
    const coords = [];

    // Method 1: Try data-deferred-state JSON blobs (Airbnb embeds listing data here)
    const deferredEls = document.querySelectorAll('[data-deferred-state]');
    for (const el of deferredEls) {
      try {
        const data = JSON.parse(el.getAttribute('data-deferred-state'));
        const str = JSON.stringify(data);
        // Look for coordinate patterns in the JSON
        const latMatches = str.matchAll(/"lat(?:itude)?"\s*:\s*([-\d.]+)/g);
        const lngMatches = str.matchAll(/"l(?:on|ng|ongitude)"\s*:\s*([-\d.]+)/g);
        const lats = [...latMatches].map(m => parseFloat(m[1])).filter(v => v > 49 && v < 61);
        const lngs = [...lngMatches].map(m => parseFloat(m[1])).filter(v => v > -8 && v < 2);
        const pairs = Math.min(lats.length, lngs.length);
        for (let i = 0; i < pairs; i++) {
          coords.push({ lat: lats[i], lng: lngs[i] });
        }
      } catch {}
    }

    // Method 2: Try script tags with __NEXT_DATA__ or similar
    if (coords.length === 0) {
      for (const script of document.querySelectorAll('script')) {
        const text = script.textContent;
        if (text.includes('latitude') && text.includes('longitude')) {
          try {
            const latMatches = text.matchAll(/"lat(?:itude)?"\s*:\s*([-\d.]+)/g);
            const lngMatches = text.matchAll(/"l(?:on|ng|ongitude)"\s*:\s*([-\d.]+)/g);
            const lats = [...latMatches].map(m => parseFloat(m[1])).filter(v => v > 49 && v < 61);
            const lngs = [...lngMatches].map(m => parseFloat(m[1])).filter(v => v > -8 && v < 2);
            const pairs = Math.min(lats.length, lngs.length);
            for (let i = 0; i < pairs; i++) {
              coords.push({ lat: lats[i], lng: lngs[i] });
            }
          } catch {}
        }
      }
    }

    return coords;
  });
}
