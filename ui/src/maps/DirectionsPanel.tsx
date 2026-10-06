// Integrated turn-by-turn directions drawer for the Worlds app.
import { useRef, useState, type FormEvent } from 'react';
import clsx from 'clsx';
import { ArrowLeftRight, Bike, Car, Footprints, Loader2, Navigation, Route as RouteIcon, X } from 'lucide-react';

export type TravelMode = 'auto' | 'bicycle' | 'pedestrian';

export interface RouteStop {
  name: string;
  lat: number;
  lon: number;
}

export interface RouteStep {
  text: string;
  km: number;
  s: number;
  type: number;
  street: string | null;
  at: [number, number] | null;
}

export interface RouteData {
  from: RouteStop;
  to: RouteStop;
  via: RouteStop[];
  mode: TravelMode;
  km: number;
  s: number;
  coords: [number, number][];
  steps: RouteStep[];
  bbox: [number, number, number, number] | null;
}

const MODE_ICON = { auto: Car, bicycle: Bike, pedestrian: Footprints };
const MODE_WORD = { auto: 'Drive', bicycle: 'Bike', pedestrian: 'Walk' };
const US = /-(US|LR|MM)\b/i.test(navigator.language);

const dist = (km: number) => (US
  ? (km * 0.621371 < 0.2 ? `${Math.round(km * 3280.84 / 10) * 10} ft` : `${(km * 0.621371).toFixed(km < 16 ? 1 : 0)} mi`)
  : km < 1 ? `${Math.round(km * 1000 / 10) * 10} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`);

const dur = (s: number) => {
  const m = Math.round(s / 60), h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${Math.max(1, m)} min`;
};

interface DirectionsPanelProps {
  initialFrom?: string;
  initialTo?: string;
  pinCoord?: { lat: number; lon: number } | null;
  onRouteReady: (data: RouteData | null) => void;
  onStepClick: (step: RouteStep) => void;
  onClose: () => void;
}

export function DirectionsPanel({
  initialFrom = '',
  initialTo = '',
  pinCoord,
  onRouteReady,
  onStepClick,
  onClose,
}: DirectionsPanelProps) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [mode, setMode] = useState<TravelMode>('auto');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<RouteData | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);

  const seq = useRef(0);
  const calculateRoute = async (fStr = from, tStr = to, m = mode) => {
    if (!fStr.trim() || !tStr.trim()) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from: fStr.trim(), to: tStr.trim(), mode: m });
      const r = await fetch(`/api/route?${qs}`);
      const d = await r.json();
      if (mine !== seq.current) return;
      if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : `HTTP ${r.status}`);
      setRoute(d);
      setActiveStep(null);
      onRouteReady(d);
    } catch (e) {
      if (mine !== seq.current) return;
      const msg = (e as Error).message;
      setError(msg);
      setRoute(null);
      onRouteReady(null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  const handleSwap = () => {
    const tmp = from;
    setFrom(to);
    setTo(tmp);
    if (to.trim() && tmp.trim()) {
      calculateRoute(to, tmp, mode);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    calculateRoute();
  };

  const usePinFor = (which: 'from' | 'to') => {
    if (!pinCoord) return;
    const str = `${pinCoord.lat.toFixed(5)}, ${pinCoord.lon.toFixed(5)}`;
    if (which === 'from') {
      setFrom(str);
      if (to.trim()) calculateRoute(str, to, mode);
    } else {
      setTo(str);
      if (from.trim()) calculateRoute(from, str, mode);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[var(--bg-secondary)] border-l border-[var(--border-subtle)] text-[12px] min-h-0 w-80">
      {/* Header */}
      <div className="p-3 border-b border-[var(--border-subtle)] flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-semibold text-[13px] text-[var(--text-primary)]">
          <RouteIcon className="w-4 h-4 text-[var(--accent)]" />
          <span>Directions</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
          title="Close directions"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Mode selection */}
      <div className="flex items-center gap-1.5 px-3 pt-3">
        {(['auto', 'bicycle', 'pedestrian'] as TravelMode[]).map(m => {
          const Icon = MODE_ICON[m];
          return (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                if (from.trim() && to.trim()) calculateRoute(from, to, m);
              }}
              className={clsx(
                'flex-1 py-1.5 px-2 rounded-md flex items-center justify-center gap-1.5 border transition font-medium',
                mode === m
                  ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--text-primary)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
              title={MODE_WORD[m]}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{MODE_WORD[m]}</span>
            </button>
          );
        })}
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} className="p-3 space-y-2">
        <div className="relative flex items-center">
          <span className="absolute left-2.5 w-2 h-2 rounded-full bg-emerald-500" />
          <input
            value={from}
            onChange={e => setFrom(e.target.value)}
            placeholder="Starting location or lat,lon…"
            className="w-full pl-7 pr-7 py-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
          />
          {pinCoord && (
            <button
              type="button"
              onClick={() => usePinFor('from')}
              className="absolute right-2 text-[10px] text-[var(--accent)] hover:underline"
              title="Use current dropped pin"
            >
              Pin
            </button>
          )}
        </div>

        <div className="flex items-center justify-center my-0.5">
          <button
            type="button"
            onClick={handleSwap}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
            title="Swap start and destination"
          >
            <ArrowLeftRight className="w-3.5 h-3.5 rotate-90" />
          </button>
        </div>

        <div className="relative flex items-center">
          <span className="absolute left-2.5 w-2 h-2 rounded-full bg-rose-500" />
          <input
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="Destination or lat,lon…"
            className="w-full pl-7 pr-7 py-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
          />
          {pinCoord && (
            <button
              type="button"
              onClick={() => usePinFor('to')}
              className="absolute right-2 text-[10px] text-[var(--accent)] hover:underline"
              title="Use current dropped pin"
            >
              Pin
            </button>
          )}
        </div>

        <button
          type="submit"
          disabled={loading || !from.trim() || !to.trim()}
          className="w-full py-2 px-3 rounded-md bg-[var(--accent)] text-white font-medium flex items-center justify-center gap-1.5 hover:opacity-90 disabled:opacity-50 transition"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
          <span>Find Route</span>
        </button>
      </form>

      {/* Results / Steps */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 min-h-0">
        {error && (
          <div className="p-2.5 rounded-md border border-rose-500/30 bg-rose-950/20 text-rose-300 text-[11px] leading-relaxed">
            {error}
          </div>
        )}

        {route && (
          <div className="space-y-3">
            {/* Route summary card */}
            <div className="p-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
              <div className="flex items-baseline gap-2">
                <span className="text-[20px] font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
                  {dur(route.s)}
                </span>
                <span className="text-[12px] text-[var(--text-muted)] tabular-nums">
                  ({dist(route.km)})
                </span>
              </div>
              <div className="mt-1.5 text-[11px] text-[var(--text-secondary)] space-y-0.5">
                <div className="truncate flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  <span className="truncate">{route.from.name}</span>
                </div>
                <div className="truncate flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                  <span className="truncate">{route.to.name}</span>
                </div>
              </div>
            </div>

            {/* Turn by turn list */}
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-1 px-1">
                Steps ({route.steps.length})
              </div>
              <ol className="divide-y divide-[var(--border-subtle)] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] overflow-hidden">
                {route.steps.map((st, i) => (
                  <li key={i}>
                    <button
                      onClick={() => {
                        setActiveStep(i);
                        onStepClick(st);
                      }}
                      className={clsx(
                        'w-full text-left grid grid-cols-[1.5rem_1fr_auto] gap-2 px-3 py-2 text-[11px] leading-snug transition hover:bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)]',
                        activeStep === i && 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
                      )}
                    >
                      <span className="text-[10px] tabular-nums text-[var(--text-muted)] pt-0.5">{i + 1}</span>
                      <span className="text-[var(--text-secondary)]">{st.text}</span>
                      <span className="text-[10px] tabular-nums text-[var(--text-muted)] pt-0.5 shrink-0">
                        {st.km > 0 ? dist(st.km) : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
