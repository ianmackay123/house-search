import { sleep } from './browser.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const cache = new Map();

export async function geocode(locationStr) {
  if (!locationStr) return null;

  // Clean up location string
  let query = locationStr
    .replace(/[()]/g, '')
    .replace(/\//g, ', ')  // "Cumbria/Lake District" → "Cumbria, Lake District"
    .replace(/\s+/g, ' ')
    .trim();
  if (!query) return null;

  if (cache.has(query)) return cache.get(query);

  // Rate limit: Nominatim requires max 1 req/sec
  await sleep(1100);

  try {
    const params = new URLSearchParams({
      q: query + ', United Kingdom',
      format: 'json',
      limit: '1',
      countrycodes: 'gb',
    });

    const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: {
        'User-Agent': 'HouseSearchScraper/1.0 (personal use)',
      },
    });

    if (!resp.ok) return null;

    const results = await resp.json();
    if (results.length > 0) {
      const result = { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
      cache.set(query, result);
      return result;
    }
  } catch (err) {
    console.warn(`[Geocode] Failed for "${query}": ${err.message}`);
  }

  // Fallback: try just the last comma-separated part (most specific place name)
  const parts = query.split(',').map(s => s.trim());
  if (parts.length > 1) {
    const fallback = parts[parts.length - 1];
    if (fallback && !cache.has(fallback)) {
      await sleep(1100);
      try {
        const params2 = new URLSearchParams({
          q: fallback + ', United Kingdom',
          format: 'json',
          limit: '1',
          countrycodes: 'gb',
        });
        const resp2 = await fetch(`${NOMINATIM_URL}?${params2}`, {
          headers: { 'User-Agent': 'HouseSearchScraper/1.0 (personal use)' },
        });
        if (resp2.ok) {
          const results2 = await resp2.json();
          if (results2.length > 0) {
            const result = { lat: parseFloat(results2[0].lat), lng: parseFloat(results2[0].lon) };
            cache.set(query, result);
            cache.set(fallback, result);
            return result;
          }
        }
      } catch {}
    } else if (cache.has(fallback)) {
      const cached = cache.get(fallback);
      cache.set(query, cached);
      return cached;
    }
  }

  cache.set(query, null);
  return null;
}
