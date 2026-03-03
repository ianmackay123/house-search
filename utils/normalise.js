const GAMES_BONUS_KEYWORDS = ['snooker', 'table tennis', 'ping pong', 'ping-pong'];

export function normalise(raw, source) {
  const games = raw.games || [];
  const gamesLower = games.map(g => g.toLowerCase()).join(' ');

  return {
    name: raw.name,
    source,
    sleeps: parseSleeps(raw.sleeps),
    location: raw.location || '',
    lat: raw.lat,
    lng: raw.lng,
    games,
    has_games_bonus: GAMES_BONUS_KEYWORDS.some(kw => gamesLower.includes(kw)),
    has_full_snooker: gamesLower.includes('full-size snooker') || /full[\s-]?size[d]?\s+snooker/.test(gamesLower),
    price: raw.price || null,
    rating: raw.rating || null,
    url: raw.url,
    image: raw.image || null,
    available_dates: raw.available_dates || [],
  };
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
