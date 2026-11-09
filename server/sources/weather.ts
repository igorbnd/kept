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

export async function getWeather(lat: number, lon: number, locationName: string, date: string, hours: { start: number; end: number } | null): Promise<WeatherObservation> {
  throw new Error("not implemented");
}
/** Demo override for when the sky refuses to cooperate on video day. Clearly flagged as simulated in evidence. */
export function setWeatherOverride(date: string, locationName: string, obs: Partial<WeatherObservation> | null): void {
  throw new Error("not implemented");
}
