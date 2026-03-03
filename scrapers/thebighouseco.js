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
      if (text.includes('hot tub')) games.push('Hot tub');
      if (text.includes('swimming pool') || text.includes('indoor pool')) games.push('Swimming pool');
      if (text.includes('tennis court')) games.push('Tennis court');
      if (text.includes('sauna')) games.push('Sauna');
      if (text.includes('games room')) games.push('Games room');
      if (text.includes('fire pit') || text.includes('fire-pit') || text.includes('firepit')) games.push('Fire pit');

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

    // Geocode location since the site has no coordinates
    const locationForGeocode = location || card.name;
    console.log(`[BHC] Geocoding "${locationForGeocode}" for ${card.name}...`);
    const coords = await geocode(locationForGeocode);

    return {
      name: card.name,
      sleeps: card.sleeps,
      location,
      lat: coords?.lat || null,
      lng: coords?.lng || null,
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
