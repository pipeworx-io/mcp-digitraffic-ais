interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Digitraffic AIS MCP — live vessel positions in Finnish and Baltic Sea waters.
 *
 * Source: Fintraffic's open marine API (meri.digitraffic.fi), keyless.
 * Live AIS (Automatic Identification System) broadcasts received by Fintraffic's
 * shore stations: position, speed over ground, course, navigational status, plus
 * static vessel metadata (name, call sign, IMO, ship type, draught, destination).
 *
 * COVERAGE: Finland and the surrounding Baltic Sea only — the Gulf of Finland,
 * Gulf of Bothnia, Archipelago Sea, Åland, and the reception fringe reaching
 * Estonia, Sweden and the northern Baltic proper. Roughly 1,000-1,500 vessels at
 * any moment. This is regional coverage from Fintraffic receivers, so a ship in
 * the Mediterranean, the Pacific or the Atlantic will be absent.
 *
 * API docs: https://www.digitraffic.fi/en/marine-traffic/
 *
 * ⚠️ QUIRK: meri.digitraffic.fi answers 406 Not Acceptable unless the request
 * advertises gzip. `Accept-Encoding: gzip` must be sent explicitly. Some runtimes
 * then hand back the still-compressed body, so readJson() sniffs the gzip magic
 * number and decompresses only when the bytes really are still compressed.
 */


const BASE = 'https://meri.digitraffic.fi/api/ais/v1';
// Fintraffic asks every client to identify itself with a descriptive header.
const DIGITRAFFIC_USER = 'Pipeworx/pipeworx.io';
const TIMEOUT_MS = 10_000;
const VESSEL_CACHE_TTL_MS = 10 * 60 * 1000;

const COVERAGE =
  'Fintraffic AIS receivers — Finland and the surrounding Baltic Sea (Gulf of Finland, Gulf of Bothnia, Archipelago Sea, Åland) with fringe reception toward Estonia and Sweden. Regional coverage, not worldwide.';

// ── AIS decode tables ────────────────────────────────────────────────
// Ship type: ITU-R M.1371 message 5 "type of ship and cargo type" byte.
// Values 20-99 follow the first-digit family; 30-39 are individually assigned.
const SHIP_TYPE_EXACT: Record<number, string> = {
  30: 'Fishing',
  31: 'Towing',
  32: 'Towing (long or wide tow)',
  33: 'Dredging or underwater operations',
  34: 'Diving operations',
  35: 'Military operations',
  36: 'Sailing',
  37: 'Pleasure craft',
  50: 'Pilot vessel',
  51: 'Search and rescue vessel',
  52: 'Tug',
  53: 'Port tender',
  54: 'Anti-pollution equipment',
  55: 'Law enforcement',
  56: 'Local vessel',
  57: 'Local vessel',
  58: 'Medical transport',
  59: 'Non-combatant ship',
};

function shipTypeLabel(code: number | null | undefined): string | null {
  if (code === null || code === undefined || !Number.isFinite(code)) return null;
  if (code <= 0 || code > 99) return null; // 0 = not available, out of range = junk
  if (SHIP_TYPE_EXACT[code]) return SHIP_TYPE_EXACT[code];
  if (code >= 20 && code <= 29) return 'Wing in ground craft';
  if (code >= 40 && code <= 49) return 'High-speed craft';
  if (code >= 60 && code <= 69) return 'Passenger';
  if (code >= 70 && code <= 79) return 'Cargo';
  if (code >= 80 && code <= 89) return 'Tanker';
  if (code >= 90 && code <= 99) return 'Other type';
  return 'Reserved';
}

export type ShipCategory = 'cargo' | 'tanker' | 'passenger' | 'fishing' | 'other';

function shipCategory(code: number | null | undefined): ShipCategory {
  if (code === null || code === undefined || !Number.isFinite(code)) return 'other';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code === 30) return 'fishing';
  return 'other';
}

// Navigational status: ITU-R M.1371 message 1/2/3 field.
const NAV_STATUS: Record<number, string> = {
  0: 'Under way using engine',
  1: 'At anchor',
  2: 'Not under command',
  3: 'Restricted manoeuvrability',
  4: 'Constrained by draught',
  5: 'Moored',
  6: 'Aground',
  7: 'Engaged in fishing',
  8: 'Under way sailing',
  9: 'Reserved (high-speed craft)',
  10: 'Reserved (wing in ground craft)',
  11: 'Power-driven vessel towing astern',
  12: 'Power-driven vessel pushing ahead or towing alongside',
  13: 'Reserved',
  14: 'AIS-SART / MOB / EPIRB active',
  15: 'Undefined',
};

// Free-text vessel_type filter → matcher. Keys are what a caller is likely to type.
const TYPE_ALIASES: Record<string, (code: number | null) => boolean> = {
  cargo: (c) => shipCategory(c) === 'cargo',
  freight: (c) => shipCategory(c) === 'cargo',
  tanker: (c) => shipCategory(c) === 'tanker',
  oil: (c) => shipCategory(c) === 'tanker',
  passenger: (c) => shipCategory(c) === 'passenger',
  ferry: (c) => shipCategory(c) === 'passenger',
  cruise: (c) => shipCategory(c) === 'passenger',
  fishing: (c) => c === 30 || c === 33,
  tug: (c) => c === 52 || c === 31 || c === 32,
  towing: (c) => c === 31 || c === 32,
  pilot: (c) => c === 50,
  sar: (c) => c === 51,
  rescue: (c) => c === 51,
  military: (c) => c === 35,
  navy: (c) => c === 35,
  warship: (c) => c === 35,
  sailing: (c) => c === 36,
  pleasure: (c) => c === 37,
  yacht: (c) => c === 36 || c === 37,
  'law enforcement': (c) => c === 55,
  police: (c) => c === 55,
  dredging: (c) => c === 33,
  'high-speed': (c) => c !== null && c >= 40 && c <= 49,
  'high speed': (c) => c !== null && c >= 40 && c <= 49,
  hsc: (c) => c !== null && c >= 40 && c <= 49,
  service: (c) => c !== null && c >= 50 && c <= 59,
  other: (c) => shipCategory(c) === 'other',
};

// ── Upstream types (exact field names returned by meri.digitraffic.fi) ──
interface LocationProperties {
  mmsi: number;
  sog: number;           // speed over ground, knots (102.3 = not available)
  cog: number;           // course over ground, degrees (360 = not available)
  navStat: number;       // navigational status code
  rot: number;           // rate of turn (-128 = not available)
  posAcc: boolean;       // true = high accuracy (<10 m)
  raim: boolean;
  heading: number;       // true heading, degrees (511 = not available)
  timestamp: number;     // UTC second of the AIS report
  timestampExternal: number; // epoch milliseconds the record was received
}

interface LocationFeature {
  mmsi: number;
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] }; // [lon, lat]
  properties: LocationProperties;
}

interface LocationCollection {
  type: 'FeatureCollection';
  dataUpdatedTime: string;
  features: LocationFeature[];
}

interface VesselMetadata {
  mmsi: number;
  name: string;
  callSign: string;
  imo: number;           // 0 = not reported
  shipType: number;
  draught: number;       // decimetres (0 = not reported)
  destination: string;
  eta: number;           // packed AIS ETA bitfield
  posType: number;
  referencePointA: number;
  referencePointB: number;
  referencePointC: number;
  referencePointD: number;
  timestamp: number;
}

// ── Tool definitions ─────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'ais_vessels_near',
    description:
      'Live vessel positions near a point: which ships are in the water around a location right now, from AIS vessel tracking. Returns per ship the MMSI, vessel name, ship type (cargo, tanker, passenger ferry, fishing, tug, sailing, pleasure craft, military), speed in knots, course, navigational status (under way, at anchor, moored, fishing), lat/lon, distance from the centre, and how fresh the report is. Use for "what ships are near Helsinki", "vessel traffic outside Turku", "is anything anchored off this port", "boats in the Gulf of Finland". COVERAGE IS REGIONAL: Fintraffic AIS receivers cover Finland and the surrounding Baltic Sea (Gulf of Finland, Gulf of Bothnia, Archipelago Sea, Åland, fringe reception toward Estonia and Sweden). Points elsewhere in the world return nothing. Example: latitude 60.15, longitude 24.95, radius_km 50 for Helsinki; add vessel_type "tanker" to see only tankers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: { type: 'number' as const, description: 'Centre latitude in decimal degrees, e.g. 60.15 for Helsinki.' },
        longitude: { type: 'number' as const, description: 'Centre longitude in decimal degrees, e.g. 24.95 for Helsinki.' },
        radius_km: { type: 'number' as const, description: 'Search radius in kilometres. Default 25, maximum 100.' },
        vessel_type: {
          type: 'string' as const,
          description:
            'Optional ship-type filter. One of: cargo, tanker, passenger, ferry, cruise, fishing, tug, towing, pilot, sar, military, sailing, pleasure, yacht, law enforcement, dredging, high-speed, service, other.',
        },
        limit: { type: 'number' as const, description: 'Maximum vessels to return, nearest first. Default 50, maximum 200.' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'ais_area_count',
    description:
      'Count how many ships are in an area right now, broken down by ship-type category and by whether they are moving or stationary. Answers "how many vessels are in this area", "how many tankers are in the Gulf of Finland", "ship traffic count in a bounding box", "how many vessels are anchored off Helsinki". Give EITHER a circle (latitude, longitude, radius_km) OR a bounding box (min_lat, max_lat, min_lon, max_lon). Returns total, by_category counts (cargo, tanker, passenger, fishing, other), moving versus stationary using a 0.5-knot threshold, and the data timestamp. COVERAGE IS REGIONAL: Fintraffic AIS receivers over Finland and the surrounding Baltic Sea; an area elsewhere in the world counts zero. Example: min_lat 59.3, max_lat 60.5, min_lon 22.0, max_lon 28.0 for the Gulf of Finland; or latitude 60.15, longitude 24.95, radius_km 50 for Helsinki.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: { type: 'number' as const, description: 'Circle mode: centre latitude in decimal degrees.' },
        longitude: { type: 'number' as const, description: 'Circle mode: centre longitude in decimal degrees.' },
        radius_km: { type: 'number' as const, description: 'Circle mode: radius in kilometres. Default 25, maximum 100.' },
        min_lat: { type: 'number' as const, description: 'Bounding-box mode: southern latitude edge.' },
        max_lat: { type: 'number' as const, description: 'Bounding-box mode: northern latitude edge.' },
        min_lon: { type: 'number' as const, description: 'Bounding-box mode: western longitude edge.' },
        max_lon: { type: 'number' as const, description: 'Bounding-box mode: eastern longitude edge.' },
        vessel_type: {
          type: 'string' as const,
          description:
            'Optional ship-type filter applied before counting. One of: cargo, tanker, passenger, fishing, tug, pilot, sar, military, sailing, pleasure, high-speed, service, other.',
        },
      },
      required: [],
    },
  },
  {
    name: 'ais_vessel',
    description:
      'Look up one specific ship by its MMSI number and get its registered details plus its latest AIS position. Returns name, call sign, IMO number, ship type, length and beam, draught, reported destination and ETA, then the live position: lat/lon, speed in knots, course, heading, navigational status, and when the report was received. Use for "where is MMSI 230052800", "track this vessel", "what ship is this MMSI". COVERAGE IS REGIONAL: the ship must have been heard by a Fintraffic receiver in Finland or the surrounding Baltic Sea. Get an MMSI from ais_vessels_near first. Example: mmsi 230052800.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mmsi: { type: 'number' as const, description: 'Maritime Mobile Service Identity, a 9-digit vessel number, e.g. 230052800.' },
      },
      required: ['mmsi'],
    },
  },
];

// ── HTTP ─────────────────────────────────────────────────────────────

/**
 * meri.digitraffic.fi refuses any request that does not advertise gzip with
 * 406 Not Acceptable, so `Accept-Encoding: gzip` is mandatory, not an
 * optimisation.
 */
async function aisFetch(path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BASE}${path}`, {
      headers: {
        'Accept-Encoding': 'gzip',
        Accept: 'application/json',
        'Digitraffic-User': DIGITRAFFIC_USER,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Digitraffic AIS request timed out after ${TIMEOUT_MS / 1000}s (${path}).`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Most runtimes transparently gunzip the body. Some hand back the compressed
 * bytes untouched once the script sets Accept-Encoding itself. The
 * Content-Encoding header is not a reliable signal either way — Node leaves it
 * in place after decompressing — so sniff the gzip magic number (1f 8b) on the
 * actual bytes and decompress only when they really are still compressed.
 */
async function readJson<T>(res: Response): Promise<T> {
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0x1f && head[1] === 0x8b && typeof DecompressionStream !== 'undefined') {
    const stream = new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text()) as T;
  }
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}

async function aisJson<T>(path: string): Promise<T> {
  const res = await aisFetch(path);
  if (!res.ok) {
    if (res.status === 406) {
      throw new Error(
        'Digitraffic AIS returned 406 Not Acceptable — the request must advertise gzip (Accept-Encoding: gzip).',
      );
    }
    const body = await res.text().catch(() => '');
    throw new Error(`Digitraffic AIS error ${res.status} on ${path}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return readJson<T>(res);
}

// ── Vessel metadata cache (in-isolate, 10 min) ───────────────────────
// /vessels is one ~1,000-row public reference list; re-fetching it for every
// position lookup would be wasteful. Nothing here is caller-specific.
let vesselCache: { byMmsi: Map<number, VesselMetadata>; expiresAt: number } | null = null;

async function vesselIndex(): Promise<Map<number, VesselMetadata>> {
  if (vesselCache && vesselCache.expiresAt > Date.now()) return vesselCache.byMmsi;
  const list = await aisJson<VesselMetadata[]>('/vessels');
  const byMmsi = new Map<number, VesselMetadata>();
  for (const v of list) if (typeof v?.mmsi === 'number') byMmsi.set(v.mmsi, v);
  vesselCache = { byMmsi, expiresAt: Date.now() + VESSEL_CACHE_TTL_MS };
  return byMmsi;
}

// ── Helpers ──────────────────────────────────────────────────────────

function num(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function requireNum(args: Record<string, unknown>, key: string, example: string): number {
  const n = num(args, key);
  if (n === null) throw new Error(`Required argument "${key}" is missing or not a number. Pass e.g. ${example}.`);
  return n;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * An empty result set comes back stamped with the Unix epoch rather than a real
 * time, which would read as a genuine (and absurd) data timestamp.
 */
function cleanAsOf(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith('1970-01-01') ? null : value;
}

function isoFromMs(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/** AIS ETA is a packed bitfield with no year: month, day, hour, minute. */
function decodeEta(eta: number | null | undefined): string | null {
  if (!eta || !Number.isFinite(eta)) return null;
  const month = (eta >> 16) & 0x0f;
  const day = (eta >> 11) & 0x1f;
  const hour = (eta >> 6) & 0x1f;
  const minute = eta & 0x3f;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(month)}-${p(day)} ${p(hour)}:${p(minute)} UTC (no year in AIS ETA)`;
}

function typeMatcher(raw: unknown): ((code: number | null) => boolean) | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const key = raw.trim().toLowerCase();
  const direct = TYPE_ALIASES[key];
  if (direct) return direct;
  // Fall back to a substring match against the decoded label, so "port tender"
  // or "anti-pollution" still work.
  return (code: number | null) => (shipTypeLabel(code) ?? '').toLowerCase().includes(key);
}

function knownTypeFilters(): string[] {
  return Object.keys(TYPE_ALIASES);
}

interface NearVessel {
  mmsi: number;
  name: string | null;
  call_sign: string | null;
  imo: number | null;
  ship_type: string | null;
  ship_type_code: number | null;
  category: ShipCategory;
  speed_knots: number | null;
  course: number | null;
  heading: number | null;
  nav_status: string | null;
  nav_status_code: number;
  position: { lat: number; lon: number };
  distance_km?: number;
  destination: string | null;
  draught_m: number | null;
  position_accuracy: 'high' | 'low';
  last_seen: string | null;
}

function shapeVessel(f: LocationFeature, meta: VesselMetadata | undefined): NearVessel {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const code = meta && meta.shipType > 0 ? meta.shipType : null;
  return {
    mmsi: f.mmsi,
    name: meta?.name?.trim() || null,
    call_sign: meta?.callSign?.trim() || null,
    imo: meta?.imo && meta.imo > 0 ? meta.imo : null,
    ship_type: shipTypeLabel(code),
    ship_type_code: code,
    category: shipCategory(code),
    // 102.3 knots is the AIS "speed not available" sentinel.
    speed_knots: p.sog >= 102.3 ? null : p.sog,
    course: p.cog >= 360 ? null : p.cog,
    heading: p.heading >= 511 ? null : p.heading,
    nav_status: NAV_STATUS[p.navStat] ?? null,
    nav_status_code: p.navStat,
    position: { lat, lon },
    destination: meta?.destination?.trim() || null,
    draught_m: meta?.draught && meta.draught > 0 ? meta.draught / 10 : null,
    position_accuracy: p.posAcc ? 'high' : 'low',
    last_seen: isoFromMs(p.timestampExternal),
  };
}

const MOVING_KNOTS = 0.5;

function isMoving(v: NearVessel): boolean {
  return v.speed_knots !== null && v.speed_knots > MOVING_KNOTS;
}

// ── Handlers ─────────────────────────────────────────────────────────

async function vesselsNear(args: Record<string, unknown>): Promise<unknown> {
  const latitude = requireNum(args, 'latitude', '60.15 (Helsinki)');
  const longitude = requireNum(args, 'longitude', '24.95 (Helsinki)');
  const radiusKm = clamp(num(args, 'radius_km') ?? 25, 1, 100);
  const limit = Math.round(clamp(num(args, 'limit') ?? 50, 1, 200));
  const match = typeMatcher(args.vessel_type);
  if (args.vessel_type !== undefined && args.vessel_type !== null && args.vessel_type !== '' && !match) {
    throw new Error(`vessel_type must be a string. Known values: ${knownTypeFilters().join(', ')}.`);
  }

  const qs = `?latitude=${latitude}&longitude=${longitude}&radius=${radiusKm}`;
  const [collection, index] = await Promise.all([
    aisJson<LocationCollection>(`/locations${qs}`),
    vesselIndex().catch(() => new Map<number, VesselMetadata>()),
  ]);

  const all = (collection.features ?? []).map((f) => {
    const v = shapeVessel(f, index.get(f.mmsi));
    v.distance_km = Math.round(haversineKm(latitude, longitude, v.position.lat, v.position.lon) * 100) / 100;
    return v;
  });
  const filtered = match ? all.filter((v) => match(v.ship_type_code)) : all;
  filtered.sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));

  return {
    center: { latitude, longitude },
    radius_km: radiusKm,
    vessel_type: match ? String(args.vessel_type) : null,
    total_in_radius: all.length,
    total_matching: filtered.length,
    returned: Math.min(filtered.length, limit),
    moving: filtered.filter(isMoving).length,
    stationary: filtered.length - filtered.filter(isMoving).length,
    as_of: cleanAsOf(collection.dataUpdatedTime),
    coverage: COVERAGE,
    source: 'Fintraffic Digitraffic marine AIS (meri.digitraffic.fi)',
    vessels: filtered.slice(0, limit),
  };
}

async function areaCount(args: Record<string, unknown>): Promise<unknown> {
  const latitude = num(args, 'latitude');
  const longitude = num(args, 'longitude');
  const minLat = num(args, 'min_lat');
  const maxLat = num(args, 'max_lat');
  const minLon = num(args, 'min_lon');
  const maxLon = num(args, 'max_lon');

  const hasBbox = minLat !== null && maxLat !== null && minLon !== null && maxLon !== null;
  const hasCircle = latitude !== null && longitude !== null;
  if (!hasBbox && !hasCircle) {
    throw new Error(
      'Give an area: either a circle (latitude, longitude, radius_km) or a bounding box (min_lat, max_lat, min_lon, max_lon). Example bbox for the Gulf of Finland: min_lat 59.3, max_lat 60.5, min_lon 22.0, max_lon 28.0.',
    );
  }

  const match = typeMatcher(args.vessel_type);
  let area: Record<string, unknown>;
  let features: LocationFeature[];
  let asOf: string | null;

  if (hasBbox) {
    // Digitraffic has no bbox filter, so pull the whole live feed (~1,000-1,500
    // vessels, a small gzipped payload) and clip client-side.
    const south = Math.min(minLat!, maxLat!);
    const north = Math.max(minLat!, maxLat!);
    const west = Math.min(minLon!, maxLon!);
    const east = Math.max(minLon!, maxLon!);
    const collection = await aisJson<LocationCollection>('/locations');
    asOf = cleanAsOf(collection.dataUpdatedTime);
    features = (collection.features ?? []).filter((f) => {
      const [lon, lat] = f.geometry.coordinates;
      return lat >= south && lat <= north && lon >= west && lon <= east;
    });
    area = { type: 'bbox', min_lat: south, max_lat: north, min_lon: west, max_lon: east };
  } else {
    const radiusKm = clamp(num(args, 'radius_km') ?? 25, 1, 100);
    const collection = await aisJson<LocationCollection>(
      `/locations?latitude=${latitude}&longitude=${longitude}&radius=${radiusKm}`,
    );
    asOf = cleanAsOf(collection.dataUpdatedTime);
    features = collection.features ?? [];
    area = { type: 'radius', latitude, longitude, radius_km: radiusKm };
  }

  const index = await vesselIndex().catch(() => new Map<number, VesselMetadata>());
  let vessels = features.map((f) => shapeVessel(f, index.get(f.mmsi)));
  if (match) vessels = vessels.filter((v) => match(v.ship_type_code));

  const byCategory: Record<ShipCategory, number> = { cargo: 0, tanker: 0, passenger: 0, fishing: 0, other: 0 };
  const byShipType: Record<string, number> = {};
  let withoutMetadata = 0;
  let moving = 0;
  for (const v of vessels) {
    byCategory[v.category] += 1;
    const label = v.ship_type ?? 'Unknown';
    byShipType[label] = (byShipType[label] ?? 0) + 1;
    if (v.ship_type_code === null) withoutMetadata += 1;
    if (isMoving(v)) moving += 1;
  }

  return {
    area,
    vessel_type: match ? String(args.vessel_type) : null,
    total: vessels.length,
    by_category: byCategory,
    by_ship_type: byShipType,
    // Vessels whose static AIS report has not been heard yet are counted under
    // by_category.other.
    without_type_metadata: withoutMetadata,
    moving,
    stationary: vessels.length - moving,
    moving_threshold_knots: MOVING_KNOTS,
    as_of: asOf,
    coverage: COVERAGE,
    source: 'Fintraffic Digitraffic marine AIS (meri.digitraffic.fi)',
  };
}

async function oneVessel(args: Record<string, unknown>): Promise<unknown> {
  const mmsi = Math.round(requireNum(args, 'mmsi', '230052800'));

  const [metaRes, locRes] = await Promise.all([
    aisFetch(`/vessels/${mmsi}`),
    aisFetch(`/locations?mmsi=${mmsi}`),
  ]);

  let meta: VesselMetadata | null = null;
  if (metaRes.ok) {
    meta = await readJson<VesselMetadata>(metaRes).catch(() => null);
  } else if (metaRes.status !== 404) {
    throw new Error(`Digitraffic AIS error ${metaRes.status} looking up vessel ${mmsi}.`);
  }

  let feature: LocationFeature | null = null;
  let asOf: string | null = null;
  if (locRes.ok) {
    const collection = await readJson<LocationCollection>(locRes).catch(() => null);
    feature = collection?.features?.[0] ?? null;
    asOf = feature ? cleanAsOf(collection?.dataUpdatedTime) : null;
  }

  if (!meta && !feature) {
    return {
      mmsi,
      found: false,
      message: `No AIS record for MMSI ${mmsi}. Either the MMSI is wrong or the vessel has not been heard by a Fintraffic receiver. ${COVERAGE}`,
      coverage: COVERAGE,
      source: 'Fintraffic Digitraffic marine AIS (meri.digitraffic.fi)',
    };
  }

  const code = meta && meta.shipType > 0 ? meta.shipType : null;
  // referencePointA/B are the distances from the AIS antenna to bow/stern and
  // C/D to port/starboard, so A+B is overall length and C+D is beam.
  const lengthM = meta ? meta.referencePointA + meta.referencePointB : 0;
  const beamM = meta ? meta.referencePointC + meta.referencePointD : 0;

  return {
    mmsi,
    found: true,
    vessel: {
      name: meta?.name?.trim() || null,
      call_sign: meta?.callSign?.trim() || null,
      imo: meta?.imo && meta.imo > 0 ? meta.imo : null,
      ship_type: shipTypeLabel(code),
      ship_type_code: code,
      category: shipCategory(code),
      length_m: lengthM > 0 ? lengthM : null,
      beam_m: beamM > 0 ? beamM : null,
      draught_m: meta?.draught && meta.draught > 0 ? meta.draught / 10 : null,
      destination: meta?.destination?.trim() || null,
      eta: decodeEta(meta?.eta),
      metadata_updated: isoFromMs(meta?.timestamp),
    },
    position: feature
      ? (() => {
          const v = shapeVessel(feature, meta ?? undefined);
          return {
            lat: v.position.lat,
            lon: v.position.lon,
            speed_knots: v.speed_knots,
            course: v.course,
            heading: v.heading,
            nav_status: v.nav_status,
            nav_status_code: v.nav_status_code,
            position_accuracy: v.position_accuracy,
            moving: isMoving(v),
            last_seen: v.last_seen,
          };
        })()
      : null,
    position_note: feature
      ? null
      : 'Registered in the AIS vessel list but no live position — the vessel is currently out of range of Fintraffic receivers.',
    as_of: asOf,
    coverage: COVERAGE,
    source: 'Fintraffic Digitraffic marine AIS (meri.digitraffic.fi)',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ais_vessels_near':
      return vesselsNear(args);
    case 'ais_area_count':
      return areaCount(args);
    case 'ais_vessel':
      return oneVessel(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
