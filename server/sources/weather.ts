// Real weather from Open-Meteo (free, no key). OWNER: watcher agent.
export type WeatherObservation = {
  date: string; // YYYY-MM-DD
  location: string;
  precipitation_mm: number;
  max_temp_c: number;
  min_temp_c: number;
  max_wind_kmh: number;
  hours: { start: number; end: number };
  simulated: boolean; // true if a demo override was used instead of Open-Meteo
  source_url: string;
};

type Hourly = { time: string[]; precipitation: (number | null)[]; temperature_2m: (number | null)[]; wind_speed_10m: (number | null)[] };

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const CACHE_TTL_MS = 10 * 60_000;
const FORECAST_PAST_DAYS = 90; // forecast API keeps ~92 past days; stay safely inside

// Cache and API-coverage decisions are about the real network/API, so they use real wall time,
// not the simulated clock.
const cache = new Map<string, { at: number; url: string; hourly: Hourly }>();
const overrides = new Map<string, Partial<WeatherObservation>>();

const overrideKey = (date: string, location: string) => `${date}|${location}`;

export function weatherUrl(lat: number, lon: number, date: string): string {
  const daysAgo = (Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
  const base = daysAgo > FORECAST_PAST_DAYS ? ARCHIVE_URL : FORECAST_URL;
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: "precipitation,temperature_2m,wind_speed_10m",
    timezone: "auto",
    start_date: date,
    end_date: date,
  });
  return `${base}?${q.toString().replace(/%2C/g, ",")}`;
}

async function fetchHourly(lat: number, lon: number, date: string): Promise<{ url: string; hourly: Hourly }> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${date}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const url = weatherUrl(lat, lon, date);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json().catch(() => null)) as { hourly?: Hourly; reason?: string } | null;
  if (!res.ok || !body?.hourly) throw new Error(`Open-Meteo ${res.status}: ${body?.reason ?? "no hourly data"} (${url})`);
  const entry = { at: Date.now(), url, hourly: body.hourly };
  cache.set(key, entry);
  return entry;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function aggregate(hourly: Hourly, hours: { start: number; end: number }) {
  const idx: number[] = [];
  hourly.time.forEach((t, i) => {
    const h = Number(t.slice(11, 13)); // "YYYY-MM-DDTHH:MM", already local (timezone=auto)
    if (h >= hours.start && h < hours.end) idx.push(i);
  });
  const vals = (arr: (number | null)[]) => idx.map((i) => arr[i]).filter((v): v is number => typeof v === "number");
  const precip = vals(hourly.precipitation);
  const temp = vals(hourly.temperature_2m);
  const wind = vals(hourly.wind_speed_10m);
  if (!precip.length && !temp.length) throw new Error("Open-Meteo returned no data for that window");
  return {
    precipitation_mm: r2(precip.reduce((s, v) => s + v, 0)),
    max_temp_c: temp.length ? r2(Math.max(...temp)) : NaN,
    min_temp_c: temp.length ? r2(Math.min(...temp)) : NaN,
    max_wind_kmh: wind.length ? r2(Math.max(...wind)) : NaN,
  };
}

export async function getWeather(lat: number, lon: number, locationName: string, date: string, hours: { start: number; end: number } | null): Promise<WeatherObservation> {
  const win = hours ?? { start: 0, end: 24 };
  const override = overrides.get(overrideKey(date, locationName));
  let real: Omit<WeatherObservation, "simulated">;
  try {
    const { url, hourly } = await fetchHourly(lat, lon, date);
    real = { date, location: locationName, hours: win, source_url: url, ...aggregate(hourly, win) };
  } catch (e) {
    if (!override) throw e;
    // Demo override still works offline; unknown metrics are left as NaN.
    real = { date, location: locationName, hours: win, source_url: weatherUrl(lat, lon, date), precipitation_mm: 0, max_temp_c: NaN, min_temp_c: NaN, max_wind_kmh: NaN };
  }
  if (!override) return { ...real, simulated: false };
  return { ...real, ...override, date, location: locationName, hours: win, source_url: real.source_url, simulated: true };
}

/** Drop every demo override (demo reset). */
export function clearWeatherOverrides(): void {
  overrides.clear();
}

/** Demo override for when the sky refuses to cooperate on video day. Clearly flagged as simulated in evidence. */
export function setWeatherOverride(date: string, locationName: string, obs: Partial<WeatherObservation> | null): void {
  const key = overrideKey(date, locationName);
  if (obs === null) overrides.delete(key);
  else overrides.set(key, { ...overrides.get(key), ...obs });
}
