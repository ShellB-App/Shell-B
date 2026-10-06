// Live weather conditions widget for pin drops on Earth (via Open-Meteo).
import { useState, useEffect } from 'react';
import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, Droplets, Loader2, Sun, Thermometer, Wind, X } from 'lucide-react';

interface LiveWeatherWidgetProps {
  lat: number;
  lon: number;
  onClose: () => void;
}

interface CurrentWeather {
  temp: number;
  feelsLike: number;
  windSpeed: number;
  humidity: number;
  precip: number;
  code: number;
  daily?: {
    time: string[];
    tempMax: number[];
    tempMin: number[];
    codes: number[];
  };
}

function wmoDesc(code: number): { text: string; icon: typeof Sun } {
  if (code === 0) return { text: 'Clear sky', icon: Sun };
  if (code <= 3) return { text: 'Partly cloudy', icon: Cloud };
  if (code <= 48) return { text: 'Foggy / Haze', icon: CloudFog };
  if (code <= 57) return { text: 'Drizzle', icon: CloudRain };
  if (code <= 67) return { text: 'Rain', icon: CloudRain };
  if (code <= 77) return { text: 'Snow', icon: CloudSnow };
  if (code <= 82) return { text: 'Rain showers', icon: CloudRain };
  if (code <= 86) return { text: 'Snow showers', icon: CloudSnow };
  if (code >= 95) return { text: 'Thunderstorm', icon: CloudLightning };
  return { text: 'Cloudy', icon: Cloud };
}

const cToF = (c: number) => Math.round((c * 9) / 5 + 32);

export function LiveWeatherWidget({ lat, lon, onClose }: LiveWeatherWidgetProps) {
  const [data, setData] = useState<CurrentWeather | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/weather?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`)
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : `HTTP ${r.status}`);
        if (!alive) return;
        const cur = d.forecast?.current;
        const daily = d.forecast?.daily;
        if (!cur) throw new Error('No weather data returned');
        setData({
          temp: cur.temperature_2m,
          feelsLike: cur.apparent_temperature ?? cur.temperature_2m,
          windSpeed: cur.wind_speed_10m ?? 0,
          humidity: cur.relative_humidity_2m ?? 0,
          precip: cur.precipitation ?? 0,
          code: cur.weather_code ?? 0,
          daily: daily ? {
            time: daily.time ?? [],
            tempMax: daily.temperature_2m_max ?? [],
            tempMin: daily.temperature_2m_min ?? [],
            codes: daily.weather_code ?? [],
          } : undefined,
        });
      })
      .catch(e => {
        if (alive) setError((e as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [lat, lon]);

  const w = data ? wmoDesc(data.code) : null;
  const Icon = w?.icon ?? Sun;

  return (
    <div className="w-[17rem] rounded-lg border border-[var(--border-subtle)] sb-map-glass p-3 text-[12px] shadow-xl backdrop-blur-md">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-1.5 font-semibold text-[12px] text-[var(--text-primary)]">
          <Thermometer className="w-3.5 h-3.5 text-amber-500" />
          <span>Local Weather</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          title="Close weather"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading && (
        <div className="py-6 flex items-center justify-center gap-2 text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Fetching forecast…</span>
        </div>
      )}

      {error && (
        <div className="py-3 text-[11px] text-rose-400 leading-snug">
          {error}
        </div>
      )}

      {data && w && (
        <div className="pt-2.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon className="w-7 h-7 text-amber-400 shrink-0" />
              <div>
                <div className="text-[17px] font-bold tracking-tight text-[var(--text-primary)] tabular-nums">
                  {Math.round(data.temp)}°C <span className="text-[12px] font-normal text-[var(--text-muted)]">({cToF(data.temp)}°F)</span>
                </div>
                <div className="text-[11px] text-[var(--text-secondary)]">{w.text}</div>
              </div>
            </div>
            <div className="text-right text-[10.5px] text-[var(--text-muted)]">
              <div>Feels like</div>
              <div className="font-semibold text-[var(--text-secondary)] tabular-nums">{Math.round(data.feelsLike)}°C</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5 p-1.5 rounded bg-[var(--bg-primary)]/60 border border-[var(--border-subtle)] text-[10.5px] text-center">
            <div>
              <div className="text-[9px] text-[var(--text-muted)] flex items-center justify-center gap-0.5">
                <Wind className="w-2.5 h-2.5" /> Wind
              </div>
              <div className="font-mono text-[var(--text-primary)] font-medium mt-0.5">{Math.round(data.windSpeed)} km/h</div>
            </div>
            <div className="border-x border-[var(--border-subtle)]">
              <div className="text-[9px] text-[var(--text-muted)] flex items-center justify-center gap-0.5">
                <Droplets className="w-2.5 h-2.5" /> Humidity
              </div>
              <div className="font-mono text-[var(--text-primary)] font-medium mt-0.5">{Math.round(data.humidity)}%</div>
            </div>
            <div>
              <div className="text-[9px] text-[var(--text-muted)] flex items-center justify-center gap-0.5">
                <CloudRain className="w-2.5 h-2.5" /> Precip
              </div>
              <div className="font-mono text-[var(--text-primary)] font-medium mt-0.5">{data.precip} mm</div>
            </div>
          </div>

          {/* Next 3 days mini forecast */}
          {data.daily && data.daily.time.length > 1 && (
            <div className="pt-1 border-t border-[var(--border-subtle)] space-y-1">
              {data.daily.time.slice(1, 4).map((day, idx) => {
                const dayName = new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short' });
                const max = Math.round(data.daily!.tempMax[idx + 1] ?? 0);
                const min = Math.round(data.daily!.tempMin[idx + 1] ?? 0);
                return (
                  <div key={day} className="flex items-center justify-between text-[10.5px] text-[var(--text-secondary)]">
                    <span className="w-8 text-[var(--text-muted)]">{dayName}</span>
                    <span className="text-[var(--text-muted)]">{wmoDesc(data.daily!.codes[idx + 1] ?? 0).text}</span>
                    <span className="font-mono tabular-nums text-right">
                      <span className="text-[var(--text-primary)] font-medium">{max}°</span>
                      <span className="text-[var(--text-muted)] ml-1.5">{min}°</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
