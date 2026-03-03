import { launchBrowser, rateLimit } from '../utils/browser.js';
import { normalise } from '../utils/normalise.js';
import { geocode } from '../utils/geocode.js';

const BASE = 'https://www.thebighouseco.com';
const LISTING_URL = `${BASE}/our-big-houses/`;
const TIMEOUT = 15000;

export async function scrapeTheBigHouseCo(options = {}) {
  console.log('[BHC] Starting The Big House Co scraper...');
  const { browser, context } = await launchBrowser();

  try {
    // Phase 1: Scrape listing page for property cards
    const page = await context.newPage();
    let cards = [];
    try {
      await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(2000);

      cards = await page.evaluate(() => {
        const results = [];
        const articles = document.querySelectorAll('article');
        for (const article of articles) {
          const nameEl = article.querySelector('h2.entry-title a');
          if (!nameEl) continue;

          const name = nameEl.textContent.trim();
          const url = nameEl.href;

          // Extract sleeps and features from .house-services list
          const featureLis = [...article.querySelectorAll('.house-services li')];
          let sleeps = null;
          const featureNames = [];

          for (const li of featureLis) {
            if (li.classList.contains('sleep-number')) {
              const sleepText = li.textContent.trim();
              const sleepsMatch = sleepText.match(/Sleeps\s+([\d/]+)/i);
              if (sleepsMatch) {
                sleeps = parseInt(sleepsMatch[1].split('/')[0], 10);
              }
            } else {
              const span = li.querySelector('span');
              if (span) featureNames.push(span.textContent.trim());
            }
          }

          // Has dogs?
          const hasDogs = !!article.querySelector('.house-services li.dogs');

          // Get thumbnail image
          const img = article.querySelector('.big-house-featured-image img');
          const dataSrc = img ? img.getAttribute('data-src') : null;
          const src = img ? img.src : null;
          const image = (dataSrc && !dataSrc.startsWith('data:') ? dataSrc : null)
            || (src && !src.startsWith('data:') ? src : null);

          results.push({ name, url, sleeps, features: featureNames, hasDogs, image });
        }
        return results;
      });

      console.log(`[BHC] Found ${cards.length} properties on listing page`);
    } catch (err) {
      console.error(`[BHC] Listing page failed: ${err.message}`);
    } finally {
      await page.close();
    }

    // Filter: sleeps >= 20 and has Dogs feature
    const qualifying = cards.filter(c => {
      if (!c.sleeps || c.sleeps < 20) return false;
      if (!c.hasDogs) return false;
      return true;
    });

    console.log(`[BHC] ${qualifying.length} properties qualify (sleeps >= 20, dogs)`);

    // Phase 2: Scrape detail pages
    const results = [];
    const toScrape = options.limit ? qualifying.slice(0, options.limit) : qualifying;

    for (const card of toScrape) {
      try {
        await rateLimit();
        const prop = await scrapeProperty(context, card);
        if (prop) results.push(normalise(prop, 'thebighouseco'));
      } catch (err) {
        console.error(`[BHC] Error scraping ${card.url}: ${err.message}`);
      }
    }

    console.log(`[BHC] Scraped ${results.length} properties successfully`);
    return results;
  } finally {
    await browser.close();
  }
}

async function scrapeProperty(context, card) {
  const page = await context.newPage();
  try {
    await page.goto(card.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1500);

    const details = await page.evaluate(() => {
      const allText = document.body.innerText;
      const text = allText.toLowerCase();

      // Games/amenities detection
      const games = [];
      if (text.includes('table tennis') || text.includes('ping pong') || text.includes('ping-pong')) games.push('Table tennis');
      if (text.includes('snooker') || text.includes('billiard')) {
        var isFull = /full[\s-]?size[d]?\s+(?:snooker|billiard)/.test(text) || /(?:12[\s-]?f(?:oo)?t|tournament[\s-]?size[d]?|professional[\s-]?size[d]?)\s+(?:snooker|billiard)/.test(text);
        games.push(isFull ? 'Full-size snooker' : 'Snooker');
      }
      if (/pool table|\btable.*pool\b|\bpool\b.*table/.test(text)) games.push('Pool');
      if (text.includes('table football') || text.includes('foosball')) games.push('Table football');
      if (text.includes('darts') || text.includes('dartboard')) games.push('Darts');
      if (text.includes('air hockey')) games.push('Air hockey');
      if (text.includes('games console') || text.includes('playstation') || text.includes('xbox') || text.includes('nintendo')) games.push('Games console');
      if (text.includes('cinema') || text.includes('movie room') || text.includes('film room')) games.push('Cinema');
      if (text.includes('piano')) games.push('Piano');
      if (text.includes('hot tub') || text.includes('jacuzzi')) games.push('Hot tub');
      if (text.includes('indoor pool') || text.includes('indoor swimming')) games.push('Indoor pool');
      else if (text.includes('outdoor pool') || text.includes('outdoor swimming') || text.includes('lido')) games.push('Outdoor pool');
      else if (text.includes('heated pool')) games.push('Heated pool');
      else if (text.includes('swimming pool') || text.includes('private pool')) games.push('Swimming pool');
      if (text.includes('tennis court')) games.push('Tennis court');
      if (text.includes('sauna')) games.push('Sauna');
      if (text.includes('games room')) games.push('Games room');
      if (text.includes('fire pit') || text.includes('fire-pit') || text.includes('firepit')) games.push('Fire pit');
      if (/\bmoated\b|(?:a|the|its|with|has|surrounded by)\s+moat\b/.test(text)) games.push('Moat');

      // Gallery images (lazy-loaded via data-src)
      const galleryImages = [...document.querySelectorAll('img[data-src]')]
        .map(img => img.getAttribute('data-src'))
        .filter(src => src && src.includes('/uploads/'));

      return { games, galleryImages };
    });

    // Extract location from name pattern "Name-Region" or "Name – Region"
    const nameMatch = card.name.match(/[-–—]\s*(.+)$/);
    const location = nameMatch ? nameMatch[1].trim() : '';

    // Use best available image: listing thumbnail or first gallery image
    const image = card.image || (details.galleryImages.length > 0 ? details.galleryImages[0] : null);

    // Extract coordinates from Google Maps embed in raw HTML (inside noscript/lazy-load wrapper)
    const html = await page.content();
    let lat = null, lng = null;
    const mapsMatch = html.match(/google\.com\/maps\/embed\?pb=[^"']*/);
    if (mapsMatch) {
      const latMatch = mapsMatch[0].match(/!3d(-?[\d.]+)/);
      const lngMatch = mapsMatch[0].match(/!2d(-?[\d.]+)/);
      if (latMatch) lat = parseFloat(latMatch[1]);
      if (lngMatch) lng = parseFloat(lngMatch[1]);
    }
    let coords_exact = !!(lat && lng);
    if (!lat || !lng) {
      const locationForGeocode = location || card.name;
      console.log(`[BHC] No map coords, geocoding "${locationForGeocode}" for ${card.name}...`);
      const coords = await geocode(locationForGeocode);
      lat = coords?.lat || null;
      lng = coords?.lng || null;
    }

    return {
      name: card.name,
      sleeps: card.sleeps,
      location,
      lat,
      lng,
      coords_exact,
      games: details.games,
      image,
      url: card.url,
      price: null,
      available_dates: [],
    };
  } finally {
    await page.close();
  }
}
