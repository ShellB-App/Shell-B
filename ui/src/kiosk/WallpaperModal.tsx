import { useState } from 'react';
import { Check, Image, Sliders, X, Sparkles, ExternalLink } from 'lucide-react';
import {
  WALLPAPERS,
  type WallpaperDef,
  getStoredWallpaperId,
  getStoredCustomUrl,
  getStoredWallpaperDim,
  saveWallpaperChoice,
} from './wallpapers';

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

export function WallpaperModal({ open, onClose, onChanged }: Props) {
  const [selectedId, setSelectedId] = useState(getStoredWallpaperId);
  const [customUrl, setCustomUrl] = useState(getStoredCustomUrl);
  const [dim, setDim] = useState(getStoredWallpaperDim);

  if (!open) return null;

  const handleSelect = (id: string) => {
    setSelectedId(id);
    saveWallpaperChoice(id, customUrl, dim);
    onChanged?.();
  };

  const handleCustomUrlApply = () => {
    saveWallpaperChoice('custom', customUrl.trim(), dim);
    setSelectedId('custom');
    onChanged?.();
  };

  const handleDimChange = (newDim: number) => {
    setDim(newDim);
    saveWallpaperChoice(selectedId, customUrl, newDim);
    onChanged?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div
        className="w-full max-w-2xl rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center text-[var(--accent-soft)]">
              <Image className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold tracking-tight text-[var(--text-primary)]">
                Kiosk Desktop Wallpaper
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                Choose a tactical schematic, ambient cosmic backdrop, or custom image URL
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Wallpapers Grid */}
          <div className="space-y-3">
            <label className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)] font-semibold">
              Preset Themes
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {WALLPAPERS.filter(w => w.id !== 'custom').map(w => {
                const isSelected = selectedId === w.id;
                return (
                  <button
                    key={w.id}
                    onClick={() => handleSelect(w.id)}
                    className={`relative rounded-xl border text-left overflow-hidden transition group flex flex-col ${
                      isSelected
                        ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/30 bg-[var(--bg-hover)]'
                        : 'border-[var(--border-subtle)] hover:border-[var(--text-muted)] bg-[var(--bg-primary)]/40'
                    }`}
                  >
                    {/* Thumbnail preview */}
                    <div
                      className="h-24 w-full relative overflow-hidden flex items-center justify-center"
                      style={{ background: w.previewGradient }}
                    >
                      {isSelected && (
                        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] flex items-center justify-center shadow-lg">
                          <Check className="w-3 h-3 stroke-[3]" />
                        </div>
                      )}
                      <span className="text-[10px] font-mono tracking-widest uppercase opacity-40 font-bold text-white px-2 py-0.5 rounded bg-black/40">
                        {w.category}
                      </span>
                    </div>

                    {/* Metadata */}
                    <div className="p-3 flex-1 flex flex-col justify-between">
                      <div className="font-semibold text-xs text-[var(--text-primary)] group-hover:text-[var(--accent-soft)] transition">
                        {w.name}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] mt-1 line-clamp-2 leading-relaxed">
                        {w.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom Image URL */}
          <div className="space-y-3 p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)]/40">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <ExternalLink className="w-3.5 h-3.5 text-[var(--accent)]" />
                Custom Image URL
              </label>
              {selectedId === 'custom' && (
                <span className="text-[10px] font-mono text-[var(--accent-soft)] font-semibold uppercase">
                  Active
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <input
                type="url"
                placeholder="https://example.com/wallpaper.jpg"
                value={customUrl}
                onChange={e => setCustomUrl(e.target.value)}
                className="flex-1 px-3 py-2 text-xs rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
              />
              <button
                onClick={handleCustomUrlApply}
                disabled={!customUrl.trim()}
                className="px-4 py-2 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-semibold hover:opacity-90 transition disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </div>

          {/* Dimming / Contrast Slider */}
          <div className="space-y-2 p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)]/40">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[var(--accent)]" />
                Wallpaper Overlay Dimming
              </label>
              <span className="text-xs font-mono text-[var(--text-muted)]">{dim}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="80"
              step="5"
              value={dim}
              onChange={e => handleDimChange(Number(e.target.value))}
              className="w-full h-1.5 bg-[var(--bg-secondary)] rounded-lg appearance-none cursor-pointer accent-[var(--accent)]"
            />
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
              Darkens the wallpaper background to maximize contrast for desktop shortcuts and open windows.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-3.5 border-t border-[var(--border-subtle)] bg-[var(--bg-primary)]/50">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
