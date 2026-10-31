'use strict';

// Turns the raw provider channel list into something a UI can present nicely:
// a clean display name, a Hebrew alias, quality + platform badges and a genre.

const QUALITY_PATTERNS = [
  [/\b(4K|UHD)\b/i, '4K'],
  [/\b(FHD|1080P?)\b/i, 'FHD'],
  [/\bHD\b/i, 'HD'],
  [/\b(SD|LQ)\b/i, 'SD'],
];

const GENRES = [
  { id: 'sport', label: 'ספורט', icon: '⚽', keywords: [/\bsport/i, /\bone ?2? ?(hd)?$/i, /football|soccer|nba|ufc/i] },
  { id: 'kids', label: 'ילדים', icon: '🧸', keywords: [/disney|junior|nick|baby|kids|cartoon|hop|yaldut|childhood|luli|logi|teen/i] },
  { id: 'entertainment', label: 'בידור', icon: '✨', keywords: [/entertai|\bprim\b|\bhot ?(3|8)\b|\bviva\b|\bshow\b/i] },
  { id: 'movies', label: 'סרטים וסדרות', icon: '🎬', keywords: [/movies?|cinema|hbo|drama|action|comedy|zone|series|bollywood|\bme ?tv\b|\bplus\b|\bfun\b|\bgold\b/i] },
  { id: 'news', label: 'חדשות וכללי', icon: '📰', keywords: [/\bchannel ?(1|8|9|10|11|12|13|14|20)\b/i, /\bmikan\b|\bkan\b|keshet|reshet|\bi24\b|news|\bhala\b/i] },
  { id: 'docs', label: 'תיעודי וטבע', icon: '🌍', keywords: [/discovery|nat ?geo|animal|travel|history|\btlc\b|science|wild|\bid\b/i] },
  { id: 'lifestyle', label: 'לייפסטייל', icon: '🍽', keywords: [/food|health|home|good ?life|fashion|cook|\bzoom\b|\bego\b|style|kabala/i] },
  { id: 'music', label: 'מוזיקה', icon: '🎵', keywords: [/music|\bmtv\b|yamtihoni|radio|hits/i] },
];

const HEBREW_NAMES = {
  'VIVA+': 'ויוה פלוס',
  'VIVA PLUS': 'ויוה פלוס',
  'VIVA': 'ויוה',
  'CHANNEL 1': 'הערוץ הראשון',
  'CHANNEL 8': 'ערוץ 8',
  'CHANNEL 9': 'ערוץ 9',
  'CHANNEL 11': 'כאן 11',
  'CHANNEL 12': 'קשת 12',
  'CHANNEL 13': 'רשת 13',
  'CHANNEL 20': 'ערוץ 14',
  'KESHET 12': 'קשת 12',
  'RESHET 13': 'רשת 13',
  'MIKAN': 'כאן 11',
  'I24': 'i24 חדשות',
  'HALA TV': 'הלא TV',
  'YES MOVIES DRAMA': 'יס דרמה',
  'YES MOVIES ACTION': 'יס אקשן',
  'YES MOVIES COMEDY': 'יס קומדי',
  'YES MOVIES KIDS': 'יס קידס',
  'MOVIES DRAMA': 'יס דרמה',
  'MOVIES ACTION': 'יס אקשן',
  'MOVIES COMEDY': 'יס קומדי',
  'MOVIES KIDS': 'יס קידס',
  'YES ACTION': 'יס אקשן',
  'YES COMEDY': 'יס קומדי',
  'YES DRAMA': 'יס דרמה',
  'DRAMA': 'דרמה',
  'ACTION': 'אקשן',
  'COMEDY': 'קומדי',
  'ZONE': 'יס זון',
  'PLUS': 'יס פלוס',
  'GOLD': 'ערוץ הזהב',
  'FUN': 'פאן',
  'ONE': 'ערוץ ONE',
  'ONE SPORT': 'ONE ספורט',
  'ONE2 SPORT': 'ONE 2 ספורט',
  'EGO TOTAL': 'אגו טוטאל',
  'GOOD LIFE': 'החיים הטובים',
  'HOME PLUS': 'בית פלוס',
  'HOP': 'הופ!',
  'HOP! CHILDHOOD': 'הופ! ילדות',
  'YALDUT ISRAELIT': 'ילדות ישראלית',
  'YALDUT': 'ילדות ישראלית',
  'LULI': 'לולי',
  'LOGI': 'לוגי',
  'JUNIOR': 'ג׳וניור',
  'BABY': 'בייבי',
  'DISNEY': 'דיסני',
  'DISNEYCHANNEL': 'דיסני צ׳אנל',
  'NICKELODEON': 'ניקלודיאון',
  'NICK JR': 'ניק ג׳וניור',
  'ZOOM': 'זום',
  'KABALA': 'קבלה',
  'YAMTIHONI': 'ים תיכוני',
  'ENTERTAINMENT': 'בידור',
  'ISRAEL ENTERTAIMENT': 'בידור ישראלי',
  'FOOD NETWORK': 'פוד נטוורק',
  'FOOD CHANNEL': 'ערוץ האוכל',
  'HEALTH': 'ערוץ הבריאות',
  'HEALTH CHANNEL': 'ערוץ הבריאות',
  'FASHION': 'אופנה',
  'TRAVEL CHANNEL': 'ערוץ הטיולים',
  'ANIMAL PIANET': 'אנימל פלאנט',
  'ANIMAL PLANET': 'אנימל פלאנט',
  'NAT GEO WILD': 'נשיונל ג׳יאוגרפיק ווילד',
  'DISCOVERY': 'דיסקברי',
  'ID': 'ID חקירות',
  'TLC': 'TLC',
  'METV': 'ME TV',
  'PRIM': 'פרים',
  'HBO': 'HBO',
  'BOLLYWOOD': 'בוליווד',
  'CINEMA 1': 'סינמה 1',
  'CINEMA 2': 'סינמה 2',
  'CINEMA 3': 'סינמה 3',
  'CINEMA 4': 'סינמה 4',
  '3': 'הוט 3',
  '8': 'הוט 8',
};

const SPORT_SUFFIX = { LIVE: 'לייב', PLUS: 'פלוס', GOLD: 'גולד' };

function hebrewFor(core) {
  const key = core.toUpperCase().replace(/\s+/g, ' ').trim();
  if (HEBREW_NAMES[key]) return HEBREW_NAMES[key];
  const sport = key.match(/^SPORT ?(\d)(?: ?(LIVE|PLUS|GOLD))?$/);
  if (sport) return 'ספורט ' + sport[1] + (sport[2] ? ' ' + SPORT_SUFFIX[sport[2]] : '');
  return null;
}

function detectGenre(core) {
  for (const genre of GENRES) {
    if (genre.keywords.some((re) => re.test(core))) return genre.id;
  }
  return 'other';
}

function normalizeChannel(raw) {
  const original = String(raw.name || '').replace(/\s+/g, ' ').trim();

  // |IL| / [US] style country prefix
  const countryMatch = original.match(/^[|[(]\s*([A-Za-z]{2,3})\s*[|\])]\s*/);
  const country = countryMatch ? countryMatch[1].toUpperCase() : null;
  const name = (countryMatch ? original.slice(countryMatch[0].length) : original).trim();

  // Platform prefix (HOT / YES / ...)
  const platformMatch = name.match(/^(HOT|YES|PARTNER|CELLCOM|STINGTV)\b/i);
  const platform = platformMatch ? platformMatch[1].toUpperCase() : null;

  let quality = null;
  for (const [re, label] of QUALITY_PATTERNS) {
    if (re.test(name)) { quality = label; break; }
  }

  // "core" = the name without country / platform / quality, used for matching
  let core = name
    .replace(/^(HOT|YES|PARTNER|CELLCOM|STINGTV)\s*/i, '')
    .replace(/\b(4K|UHD|FHD|1080P?|HD|SD|LQ)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!core) core = name;

  const nameHe = hebrewFor(core);

  return {
    id: raw.stream_id,
    num: raw.num,
    name,
    nameHe,
    searchText: [original, name, core, nameHe || ''].join(' ').toLowerCase(),
    logo: raw.stream_icon || null,
    epgId: raw.epg_channel_id || null,
    country,
    platform,
    quality,
    genre: detectGenre(core + ' ' + name),
    group: raw.category_name || null,
    adult: raw.is_adult === '1' || raw.is_adult === 1,
  };
}

function buildCatalog(rawStreams, categories) {
  const catById = new Map((categories || []).map((c) => [String(c.category_id), c.category_name]));
  const channels = (rawStreams || [])
    .filter((s) => s && s.stream_id)
    .map((s) => normalizeChannel({ ...s, category_name: catById.get(String(s.category_id)) || null }));

  const counts = {};
  for (const ch of channels) counts[ch.genre] = (counts[ch.genre] || 0) + 1;

  const genres = [...GENRES, { id: 'other', label: 'שונות', icon: '📺' }]
    .filter((g) => counts[g.id])
    .map((g) => ({ id: g.id, label: g.label, icon: g.icon, count: counts[g.id] }));

  const countries = [...new Set(channels.map((c) => c.country).filter(Boolean))].sort();
  const groups = [...new Set(channels.map((c) => c.group).filter(Boolean))].sort();

  return { channels, genres, countries, groups };
}

module.exports = { buildCatalog, normalizeChannel, GENRES };
