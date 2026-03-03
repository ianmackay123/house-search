const GAMES_BONUS_KEYWORDS = ['snooker', 'table tennis', 'ping pong', 'ping-pong'];

const POOL_KEYWORDS = ['swimming pool', 'indoor pool', 'outdoor pool', 'heated pool', 'private pool'];
const HOT_TUB_KEYWORDS = ['hot tub', 'jacuzzi'];

export function normalise(raw, source) {
  const games = raw.games || [];
  const gamesLower = games.map(g => g.toLowerCase()).join(' ');

  // Detect pool type
  const poolType = detectPoolType(games, source);
  const hasHotTub = HOT_TUB_KEYWORDS.some(kw => gamesLower.includes(kw));
  const hasPool = poolType !== null;

  return {
    name: raw.name,
    source,
    sleeps: parseSleeps(raw.sleeps),
    location: raw.location || '',
    lat: raw.lat,
    lng: raw.lng,
    coords_exact: raw.coords_exact !== undefined ? raw.coords_exact : !!(raw.lat && raw.lng),
    games,
    has_games_bonus: GAMES_BONUS_KEYWORDS.some(kw => gamesLower.includes(kw)),
    has_full_snooker: gamesLower.includes('full-size snooker')
      || /full[\s-]?size[d]?\s+(?:snooker|billiard)/.test(gamesLower)
      || /(?:12[\s-]?f(?:oo)?t|tournament[\s-]?size[d]?|professional[\s-]?size[d]?)\s+(?:snooker|billiard)/.test(gamesLower),
    has_pool_or_hottub: hasPool || hasHotTub,
    pool_type: poolType,
    has_hot_tub: hasHotTub,
    price: raw.price || null,
    rating: raw.rating || null,
    url: raw.url,
    image: raw.image || null,
    available_dates: raw.available_dates || [],
  };
}

function detectPoolType(games, source) {
  const gamesLower = games.map(g => g.toLowerCase());

  for (const g of gamesLower) {
    if (g.includes('indoor pool') || g.includes('indoor swimming')) return 'indoor';
    if (g.includes('outdoor pool') || g.includes('outdoor swimming') || g.includes('lido')) return 'outdoor';
    if (g.includes('heated pool')) return 'heated';
  }

  // Airbnb stores "Pool" (not "Pool table") for swimming pools
  // Other scrapers use "Swimming pool"
  for (const g of gamesLower) {
    if (g.includes('swimming pool') || g.includes('private pool')) return 'unknown';
    // Airbnb: bare "Pool" that isn't "Pool table"
    if (source === 'airbnb' && g === 'pool') return 'unknown';
  }

  return null;
}

function parseSleeps(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    // Handle "22-26" → take upper bound (max capacity)
    const rangeMatch = val.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (rangeMatch) return Math.max(parseInt(rangeMatch[1], 10), parseInt(rangeMatch[2], 10));
    const match = val.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }
  return null;
}
