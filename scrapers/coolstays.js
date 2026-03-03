import { launchBrowser, rateLimit } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';

const BASE = 'https://www.coolstays.com';
// UK bounding box, guests=20, dates Sep 25-28 2026, dog-friendly filter
const SEARCH_URL = `${BASE}/search?bbox=-8,49,2,61&guests=20&checkin=2026-09-25&checkout=2026-09-28&filter=DogFriendly`;
const TIMEOUT = 20000;

export async function scrapeCoolstays(options = {}) {
  console.log('[CS] Starting Coolstays scraper...');
  const { browser, context } = await launchBrowser();

  try {
    // Phase 1: Search page — extract property cards (JS-rendered)
    const candidates = await scrapeSearchPage(context);
    console.log(`[CS] ${candidates.length} candidates from search`);

    if (candidates.length === 0) return [];

    const toScrape = options.limit ? candidates.slice(0, options.limit) : candidates;

    // Phase 2: Visit detail pages for games, coordinates via JSON-LD
    const results = [];
    for (const candidate of toScrape) {
      try {
        await rateLimit();
        const prop = await scrapeProperty(context, candidate);
        if (prop) results.push(normalise(prop, 'coolstays'));
      } catch (err) {
        console.error(`[CS] Error scraping ${candidate.name}: ${err.message}`);
      }
    }

    console.log(`[CS] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function scrapeSearchPage(context) {
  const page = await context.newPage();
  try {
    console.log('[CS] Loading search page...');
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Wait for property cards to render
    try {
      await page.waitForSelector('.property-card', { timeout: 15000 });
    } catch {
      console.log('[CS] No property cards found');
      return [];
    }

    // Wait for all cards to load
    await page.waitForTimeout(5000);

    // Scroll to bottom to trigger any lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    const cards = await page.evaluate(() => {
      const results = [];
      const propertyCards = document.querySelectorAll('.property-card');

      for (const card of propertyCards) {
        const nameEl = card.querySelector('h5');
        const link = card.querySelector('a[href*="/property/"]');
        if (!nameEl || !link) continue;

        const name = nameEl.textContent.trim();
        const url = link.href;
        const text = card.innerText;

        // Extract sleeps: "Sleeps 20" or "12 or 20 people"
        const sleepsMatch = text.match(/sleeps?\s+(\d+)/i) || text.match(/(\d+)\s+people/i);
        const sleeps = sleepsMatch ? parseInt(sleepsMatch[1], 10) : null;

        // Extract image
        const img = card.querySelector('img');
        const imgSrc = img ? img.src : null;

        // Extract price: "£5,621" or "From £900 / night"
        const priceMatch = text.match(/£([\d,]+)/);
        const price = priceMatch ? `£${priceMatch[1]}` : null;

        // Extract location from card text (first lines are region/area)
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const location = lines.length >= 2 ? `${lines[1]}, ${lines[0]}` : '';

        results.push({
          name,
          url,
          sleeps,
          image: imgSrc && !imgSrc.startsWith('data:') ? imgSrc : null,
          price,
          location,
        });
      }
      return results;
    });

    console.log(`[CS] Found ${cards.length} property cards`);
    return cards;
  } finally {
    await page.close();
  }
}

async function scrapeProperty(context, candidate) {
  const page = await context.newPage();
  try {
    await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    const details = await page.evaluate(() => {
      // Extract JSON-LD VacationRental data for coordinates
      let jsonLd = null;
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent);
          if (data['@type'] === 'VacationRental') {
            jsonLd = data;
            break;
          }
        } catch {}
      }

      const text = document.body.innerText.toLowerCase();

      // Games/amenities detection
      const games = [];
      if (text.includes('table tennis') || text.includes('ping pong') || text.includes('ping-pong')) games.push('Table tennis');
      if (text.includes('snooker') || text.includes('billiard')) {
        var isFull = /full[\s-]?size[d]?\s+(?:snooker|billiard)/.test(text) || /(?:12[\s-]?f(?:oo)?t|tournament[\s-]?size[d]?|professional[\s-]?size[d]?)\s+(?:snooker|billiard)/.test(text);
        games.push(isFull ? 'Full-size snooker' : 'Snooker');
      }
      if (/pool table|\btable.*pool\b|\bpool\b.*table/.test(text) || text.includes('pool/snooker')) games.push('Pool');
      if (text.includes('table football') || text.includes('foosball')) games.push('Table football');
      if (text.includes('darts') || text.includes('dartboard')) games.push('Darts');
      if (text.includes('air hockey')) games.push('Air hockey');
      if (text.includes('games console') || text.includes('playstation') || text.includes('xbox') || text.includes('nintendo')) games.push('Games console');
      if (text.includes('cinema') || text.includes('movie room') || text.includes('film room') || text.includes('home cinema')) games.push('Cinema');
      if (text.includes('piano')) games.push('Piano');
      if (text.includes('hot tub') || text.includes('jacuzzi')) games.push('Hot tub');
      if (text.includes('indoor pool') || text.includes('indoor swimming')) games.push('Indoor pool');
      else if (text.includes('outdoor pool') || text.includes('outdoor swimming') || text.includes('lido')) games.push('Outdoor pool');
      else if (text.includes('heated pool')) games.push('Heated pool');
      else if (text.includes('swimming pool') || text.includes('private pool')) games.push('Swimming pool');
      if (text.includes('tennis court')) games.push('Tennis court');
      if (text.includes('sauna') || text.includes('steam room')) games.push('Sauna');
      if (text.includes('games room') || text.includes('games barn')) games.push('Games room');
      if (text.includes('fire pit') || text.includes('fire-pit') || text.includes('firepit')) games.push('Fire pit');
      if (/\bmoated?\b/.test(text) && !/house on the moat/.test(text)) games.push('Moat');

      return { jsonLd, games };
    });

    const ld = details.jsonLd;
    const lat = ld?.geo?.latitude || null;
    const lng = ld?.geo?.longitude || null;
    const location = ld
      ? [ld.address?.addressLocality, ld.address?.addressRegion].filter(Boolean).join(', ')
      : candidate.location;
    const sleeps = ld?.containsPlace?.occupancy?.value || candidate.sleeps;

    return {
      name: ld?.name || candidate.name,
      sleeps,
      location,
      lat,
      lng,
      coords_exact: !!(lat && lng),
      games: details.games,
      image: candidate.image,
      url: candidate.url,
      price: candidate.price,
      available_dates: [],
    };
  } finally {
    await page.close();
  }
}
