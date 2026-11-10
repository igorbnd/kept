// The "moment" a promise is written in: season, upcoming holidays, the shop's local time, and the
// real forecast at the shop. All deterministic code. Claude reads this to suggest promises, and
// the expected-cost math reads Open-Meteo's history (never the model) to price them.
import { localDate, localParts } from "../watcher.ts";

export type Holiday = { name: string; date: string; days_away: number };
export type ForecastDay = { date: string; weekday: string; rain_mm: number; rain_chance_pct: number | null; high_c: number; low_c: number; wind_max_kmh: number };
export type MomentContext = {
  today: string; // YYYY-MM-DD, shop time
  weekday: string;
  part_of_day: "morning" | "afternoon" | "evening" | "night";
  season: string; // "late autumn"
  location: string;
  upcoming_holidays: Holiday[]; // next 60 days
  forecast: ForecastDay[]; // next 7 days at the shop, from Open-Meteo (empty if unavailable)
  forecast_url: string | null;
};

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** The nth (1-based) weekday (0 = Sunday) of a month; n = -1 for the last one. */
function nthWeekday(y: number, m: number, weekday: number, n: number): Date {
  if (n > 0) {
    const first = utcDay(y, m, 1);
    return utcDay(y, m, 1 + ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7);
  }
  const last = utcDay(y, m + 1, 0);
  return utcDay(y, m, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
}

/** US retail holidays that change what (and when) people buy. */
export function usHolidays(year: number): { name: string; date: string }[] {
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const plus = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
  return [
    { name: "New Year's Day", date: ymd(utcDay(year, 1, 1)) },
    { name: "Valentine's Day", date: ymd(utcDay(year, 2, 14)) },
    { name: "Mother's Day", date: ymd(nthWeekday(year, 5, 0, 2)) },
    { name: "Memorial Day", date: ymd(nthWeekday(year, 5, 1, -1)) },
    { name: "Father's Day", date: ymd(nthWeekday(year, 6, 0, 3)) },
    { name: "Independence Day", date: ymd(utcDay(year, 7, 4)) },
    { name: "Labor Day", date: ymd(nthWeekday(year, 9, 1, 1)) },
    { name: "Halloween", date: ymd(utcDay(year, 10, 31)) },
    { name: "Thanksgiving", date: ymd(thanksgiving) },
    { name: "Black Friday", date: ymd(plus(thanksgiving, 1)) },
    { name: "Cyber Monday", date: ymd(plus(thanksgiving, 4)) },
    { name: "Christmas Eve", date: ymd(utcDay(year, 12, 24)) },
    { name: "Christmas Day", date: ymd(utcDay(year, 12, 25)) },
    { name: "New Year's Eve", date: ymd(utcDay(year, 12, 31)) },
  ];
}

export function upcomingHolidays(today: string, withinDays = 60): Holiday[] {
  const y = Number(today.slice(0, 4));
  return [...usHolidays(y), ...usHolidays(y + 1)]
    .map((h) => ({ ...h, days_away: dayDiff(today, h.date) }))
    .filter((h) => h.days_away >= 0 && h.days_away <= withinDays);
}

/** Meteorological season with early/mid/late, northern or southern hemisphere. */
export function seasonOf(today: string, lat: number): string {
  const m = Number(today.slice(5, 7));
  const names = lat >= 0 ? ["winter", "spring", "summer", "autumn"] : ["summer", "autumn", "winter", "spring"];
  const idx = Math.floor((m % 12) / 3); // Dec-Feb 0, Mar-May 1, ...
  const pos = ["early", "mid", "late"][(m % 12) % 3];
  return `${pos} ${names[idx]}`;
}

const PART_OF_DAY = (h: number): MomentContext["part_of_day"] => (h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "night");

// ---------- Open-Meteo: 7-day forecast and multi-year history ----------

type Daily = { time: string[]; precipitation_sum: (number | null)[]; precipitation_probability_max?: (number | null)[]; temperature_2m_max: (number | null)[]; temperature_2m_min: (number | null)[]; wind_speed_10m_max: (number | null)[] };
const forecastCache = new Map<string, { at: number; days: ForecastDay[]; url: string }>();

async function forecast(lat: number, lon: number): Promise<{ days: ForecastDay[]; url: string }> {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    daily: "precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,wind_speed_10m_max",
    timezone: "auto",
    forecast_days: "7",
  });
  const url = `https://api.open-meteo.com/v1/forecast?${q.toString().replace(/%2C/g, ",")}`;
  const hit = forecastCache.get(url);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const body = (await res.json().catch(() => null)) as { daily?: Daily } | null;
  if (!res.ok || !body?.daily) throw new Error(`Open-Meteo forecast ${res.status}`);
  const d = body.daily;
  const n = (v: number | null | undefined) => (typeof v === "number" ? Math.round(v * 10) / 10 : NaN);
  const days = d.time.map((date, i) => ({
    date,
    weekday: WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()],
    rain_mm: n(d.precipitation_sum[i]),
    rain_chance_pct: d.precipitation_probability_max ? n(d.precipitation_probability_max[i]) : null,
    high_c: n(d.temperature_2m_max[i]),
    low_c: n(d.temperature_2m_min[i]),
    wind_max_kmh: n(d.wind_speed_10m_max[i]),
  }));
  const entry = { at: Date.now(), days, url };
  forecastCache.set(url, entry);
  return entry;
}

export async function momentContext(at: Date, timezone: string, home: { name: string; lat: number; lon: number }): Promise<MomentContext> {
  const today = localDate(at, timezone);
  const p = localParts(at, timezone);
  let fc: { days: ForecastDay[]; url: string } | null = null;
  try {
    fc = await forecast(home.lat, home.lon);
  } catch {
    fc = null; // suggestions still work without the forecast; they just can't mention it
  }
  return {
    today,
    weekday: WEEKDAY[p.weekday],
    part_of_day: PART_OF_DAY(p.hour),
    season: seasonOf(today, home.lat),
    location: home.name,
    upcoming_holidays: upcomingHolidays(today),
    forecast: fc?.days ?? [],
    forecast_url: fc?.url ?? null,
  };
}

export type HourlyHistory = { time: string[]; precipitation: (number | null)[]; temperature_2m: (number | null)[]; wind_speed_10m: (number | null)[] };
const historyCache = new Map<string, { at: number; data: HourlyHistory }>();

/**
 * Hourly weather for the same calendar window (from `today`, `days` long) in each of the past
 * `years` years, from Open-Meteo's archive. Used to price weather promises from history.
 */
export async function sameWindowHistory(lat: number, lon: number, today: string, days = 30, years = 5): Promise<{ data: HourlyHistory; url: string }> {
  const y0 = Number(today.slice(0, 4));
  const fetchYear = async (y: number) => {
    const start = `${y}${today.slice(4)}`;
    const end = ymd(new Date(Date.parse(`${start}T00:00:00Z`) + (days - 1) * 86_400_000));
    const q = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: "precipitation,temperature_2m,wind_speed_10m", timezone: "auto", start_date: start, end_date: end });
    const url = `https://archive-api.open-meteo.com/v1/archive?${q.toString().replace(/%2C/g, ",")}`;
    const hit = historyCache.get(url);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return { data: hit.data, url };
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => null)) as { hourly?: HourlyHistory } | null;
    if (!res.ok || !body?.hourly) throw new Error(`Open-Meteo archive ${res.status}`);
    historyCache.set(url, { at: Date.now(), data: body.hourly });
    return { data: body.hourly, url };
  };
  const parts = await Promise.all(Array.from({ length: years }, (_, i) => fetchYear(y0 - 1 - i)));
  const data: HourlyHistory = { time: [], precipitation: [], temperature_2m: [], wind_speed_10m: [] };
  for (const { data: h } of parts) {
    data.time.push(...h.time);
    data.precipitation.push(...h.precipitation);
    data.temperature_2m.push(...h.temperature_2m);
    data.wind_speed_10m.push(...h.wind_speed_10m);
  }
  return { data, url: parts[0].url };
}

export type ClimateSummary = {
  days: number;
  years: number;
  window: string; // "Nov 10 – Dec 9"
  // Percentiles across days, for the whole day and for the evening (16–20 h), so the agent can pick
  // thresholds that pay out rarely enough to afford and often enough to mean something.
  rain_days_pct: { at_least_1mm: number; at_least_5mm: number; evening_at_least_1mm: number };
  low_c: { p10: number; p50: number; p90: number };
  high_c: { p10: number; p50: number; p90: number };
  evening_low_c: { p10: number; p50: number; p90: number };
  max_wind_kmh: { p50: number; p90: number; days_over_25_pct: number; days_over_30_pct: number };
};

const pct = (sorted: number[], q: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10 : NaN);
const share = (xs: number[], f: (x: number) => boolean) => (xs.length ? Math.round((100 * xs.filter(f).length) / xs.length) : NaN);

export function climateSummary(h: HourlyHistory, years: number, days: number, today: string): ClimateSummary {
  type Day = { rain: number; eveRain: number; temps: number[]; eveTemps: number[]; wind: number[] };
  const byDay = new Map<string, Day>();
  h.time.forEach((t, i) => {
    const hour = Number(t.slice(11, 13));
    const d = byDay.get(t.slice(0, 10)) ?? { rain: 0, eveRain: 0, temps: [], eveTemps: [], wind: [] };
    const p = h.precipitation[i], temp = h.temperature_2m[i], w = h.wind_speed_10m[i];
    const eve = hour >= 16 && hour < 20;
    if (typeof p === "number") { d.rain += p; if (eve) d.eveRain += p; }
    if (typeof temp === "number") { d.temps.push(temp); if (eve) d.eveTemps.push(temp); }
    if (typeof w === "number") d.wind.push(w);
    byDay.set(t.slice(0, 10), d);
  });
  const all = [...byDay.values()].filter((d) => d.temps.length);
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const lows = sorted(all.map((d) => Math.min(...d.temps)));
  const highs = sorted(all.map((d) => Math.max(...d.temps)));
  const eveLows = sorted(all.filter((d) => d.eveTemps.length).map((d) => Math.min(...d.eveTemps)));
  const winds = sorted(all.filter((d) => d.wind.length).map((d) => Math.max(...d.wind)));
  const q3 = (xs: number[]) => ({ p10: pct(xs, 0.1), p50: pct(xs, 0.5), p90: pct(xs, 0.9) });
  const fmt = (ymdStr: string) => new Date(`${ymdStr}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const end = new Date(Date.parse(`${today}T12:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return {
    days: all.length,
    years,
    window: `${fmt(today)} – ${fmt(end)}`,
    rain_days_pct: { at_least_1mm: share(all.map((d) => d.rain), (x) => x >= 1), at_least_5mm: share(all.map((d) => d.rain), (x) => x >= 5), evening_at_least_1mm: share(all.map((d) => d.eveRain), (x) => x >= 1) },
    low_c: q3(lows),
    high_c: q3(highs),
    evening_low_c: q3(eveLows),
    max_wind_kmh: { p50: pct(winds, 0.5), p90: pct(winds, 0.9), days_over_25_pct: share(winds, (x) => x > 25), days_over_30_pct: share(winds, (x) => x > 30) },
  };
}
