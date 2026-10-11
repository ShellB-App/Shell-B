// Bookmarks and curated planetary wonders modal/drawer for the Worlds app.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Bookmark, Box, Download, MapPin, Navigation, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { getBookmarks, removeBookmark, addBookmark, type Bookmark as BookmarkItem } from './bookmarks';
import { fmtCoord, type MapSpec } from './core';
import { bookmarksToPlaces, download, parseGeoFile, toGeoJSON, toKML } from './io';
import { fetchModels, type ModelInfo } from './models';
import { ModelThumb } from './ModelViewer';
import { openModel } from './notes';

interface BookmarksModalProps {
  currentBodyId: string;
  pinCoord: { lat: number; lon: number } | null;
  onSelect: (b: BookmarkItem) => void;
  onClose: () => void;
  /** a GeoJSON / KML / GPX file the user imported, parsed into an overlay */
  onImport?: (spec: MapSpec) => void;
}

export function BookmarksModal({ currentBodyId, pinCoord, onSelect, onClose, onImport }: BookmarksModalProps) {
  const [tab, setTab] = useState<'places' | 'models'>('places');
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (tab === 'models' && !models) fetchModels().then(setModels); }, [tab, models]);
  const exportAs = (fmt: 'kml' | 'geojson') => {
    const mine = bookmarks.filter(b => !b.curated);
    const places = bookmarksToPlaces(mine.length ? mine : bookmarks);
    if (fmt === 'kml') download('worlds-bookmarks.kml', toKML('Shell:B Worlds bookmarks', places), 'application/vnd.google-earth.kml+xml');
    else download('worlds-bookmarks.geojson', toGeoJSON(places), 'application/geo+json');
  };
  const importFile = (f: File) => {
    setImportErr(null);
    f.text().then(txt => {
      const spec = parseGeoFile(f.name, txt);
      if (!spec) { setImportErr('No places or paths found in that file (GeoJSON, KML or GPX).'); return; }
      onImport?.(spec);
    }).catch(() => setImportErr('That file couldn’t be read.'));
  };
  const [filterCurrent, setFilterCurrent] = useState(true);
  const [bookmarks, setBookmarks] = useState(() => getBookmarks());
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const displayed = filterCurrent
    ? bookmarks.filter(b => b.bodyId.toLowerCase() === currentBodyId.toLowerCase())
    : bookmarks;

  const handleRemove = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeBookmark(id);
    setBookmarks(getBookmarks());
  };

  const handleSavePin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinCoord || !newName.trim()) return;
    const created = addBookmark({
      bodyId: currentBodyId,
      name: newName.trim(),
      desc: newDesc.trim() || undefined,
      lat: pinCoord.lat,
      lon: pinCoord.lon,
      zoom: 12,
    });
    setBookmarks(getBookmarks());
    setSaving(false);
    setNewName('');
    setNewDesc('');
    onSelect(created);
  };

  return (
    <div className="w-80 h-full bg-[var(--bg-secondary)] border-l border-[var(--border-subtle)] flex flex-col min-h-0 text-[12px] shadow-2xl">
      {/* Header */}
      <div className="p-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-semibold text-[13px] text-[var(--text-primary)]">
          <Bookmark className="w-4 h-4 text-amber-400" />
          <span>Saved & Curated Places</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex border-b border-[var(--border-subtle)] px-2 pt-2 gap-1 text-[11px]">
        <button onClick={() => setTab('places')} className={clsx('px-2.5 py-1.5 rounded-t-md border-b-2 font-medium transition', tab === 'places' ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]')}>
          <span className="flex items-center gap-1.5"><Bookmark className="w-3.5 h-3.5" /> Saved places</span>
        </button>
        <button onClick={() => setTab('models')} className={clsx('px-2.5 py-1.5 rounded-t-md border-b-2 font-medium transition', tab === 'models' ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]')}>
          <span className="flex items-center gap-1.5"><Box className="w-3.5 h-3.5" /> 3D models{models ? ` (${models.length})` : ''}</span>
        </button>
      </div>

      {tab === 'models' && (
        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {!models ? <div className="p-6 text-center text-[var(--text-muted)]">Loading…</div> : models.length === 0 ? (
            <div className="p-6 text-center text-[var(--text-muted)]">
              <Box className="w-6 h-6 mx-auto mb-2 opacity-40" />
              <p>No models installed. Run <code className="font-mono">fetch_models.py</code> in ~/shellb/maps/models on the Spark.</p>
            </div>
          ) : (
            <>
              <p className="px-1 pb-2 text-[10.5px] text-[var(--text-muted)] leading-snug">NASA 3D Resources: spacecraft, landers and rovers. Models also appear on the cards of the sites they belong to; Atlas can show one with a map block’s “model” key.</p>
              <div className="grid grid-cols-2 gap-1.5">
                {[...models].sort((a, b) => (a.bodies?.includes(currentBodyId) ? 0 : 1) - (b.bodies?.includes(currentBodyId) ? 0 : 1) || a.name.localeCompare(b.name)).map(m => (
                  <button key={m.id} onClick={() => openModel(m)} className="group text-left rounded-lg border border-[var(--border-subtle)] bg-gradient-to-b from-[#0b0d14] to-[#141826] overflow-hidden hover:border-[var(--accent)] transition" title={m.description}>
                    <ModelThumb src={m.url} alt={m.name} className="h-24" />
                    <div className="px-2 py-1.5">
                      <div className="text-[11px] font-medium text-slate-100 truncate">{m.name}</div>
                      <div className="text-[9.5px] text-slate-400 truncate">{m.tags.slice(0, 2).join(' · ')}{m.bodies?.includes(currentBodyId) ? ' · here' : ''}</div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'places' && <>
      {/* Tabs */}
      <div className="flex border-b border-[var(--border-subtle)] p-2 gap-1 bg-[var(--bg-primary)]/40">
        <button
          onClick={() => setFilterCurrent(true)}
          className={clsx(
            'flex-1 py-1 rounded text-[11px] font-medium transition',
            filterCurrent
              ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-semibold'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          )}
        >
          {currentBodyId[0].toUpperCase() + currentBodyId.slice(1)} ({bookmarks.filter(b => b.bodyId === currentBodyId).length})
        </button>
        <button
          onClick={() => setFilterCurrent(false)}
          className={clsx(
            'flex-1 py-1 rounded text-[11px] font-medium transition',
            !filterCurrent
              ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-semibold'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          )}
        >
          All Worlds ({bookmarks.length})
        </button>
      </div>

      {/* Save pin action */}
      {pinCoord && (
        <div className="p-3 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]">
          {!saving ? (
            <button
              onClick={() => {
                setSaving(true);
                setNewName(`Pin at ${pinCoord.lat.toFixed(2)}, ${pinCoord.lon.toFixed(2)}`);
              }}
              className="w-full py-1.5 px-2.5 rounded-md border border-[var(--accent)] text-[var(--accent)] font-medium flex items-center justify-center gap-1.5 hover:bg-[var(--accent)] hover:text-white transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Bookmark Dropped Pin</span>
            </button>
          ) : (
            <form onSubmit={handleSavePin} className="space-y-2">
              <div className="text-[11px] font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-rose-500" />
                <span>Save Location</span>
              </div>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Bookmark name…"
                className="w-full px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] text-[11px]"
                autoFocus
              />
              <input
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                placeholder="Notes or description (optional)…"
                className="w-full px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] text-[11px]"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={!newName.trim()}
                  className="flex-1 py-1 rounded bg-[var(--accent)] text-[var(--accent-fg)] font-medium hover:opacity-90 disabled:opacity-50 text-[11px]"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setSaving(false)}
                  className="px-2.5 py-1 rounded border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] text-[11px]"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0">
        {displayed.length === 0 ? (
          <div className="p-6 text-center text-[var(--text-muted)]">
            <Bookmark className="w-6 h-6 mx-auto mb-2 opacity-40" />
            <p>No bookmarks found for {filterCurrent ? currentBodyId : 'this filter'}.</p>
          </div>
        ) : (
          displayed.map(b => (
            <div
              key={b.id}
              onClick={() => onSelect(b)}
              className="p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] hover:border-[var(--accent)] cursor-pointer transition group"
            >
              <div className="flex items-start justify-between gap-1.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {b.curated ? (
                      <Sparkles className="w-3 h-3 text-amber-400 shrink-0" />
                    ) : (
                      <MapPin className="w-3 h-3 text-[var(--accent)] shrink-0" />
                    )}
                    <span className="font-semibold text-[var(--text-primary)] truncate">{b.name}</span>
                    <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] px-1 rounded bg-[var(--bg-tertiary)] ml-auto shrink-0">
                      {b.bodyId}
                    </span>
                  </div>
                  {b.desc && (
                    <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-snug line-clamp-2">
                      {b.desc}
                    </p>
                  )}
                  <div className="mt-1.5 flex items-center justify-between text-[10px] text-[var(--text-muted)] font-mono tabular-nums">
                    <span>{fmtCoord(b.lat, b.lon)}</span>
                    <span className="text-[var(--accent)] flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                      <Navigation className="w-3 h-3" /> Fly
                    </span>
                  </div>
                </div>
                {!b.curated && (
                  <button
                    onClick={e => handleRemove(b.id, e)}
                    className="p-1 rounded text-[var(--text-muted)] hover:text-rose-400 transition opacity-0 group-hover:opacity-100"
                    title="Delete bookmark"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Import / export */}
      <div className="p-2 border-t border-[var(--border-subtle)] flex items-center gap-1.5 text-[10.5px]">
        <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]" title="Show a GeoJSON, KML or GPX file on the map">
          <Upload className="w-3 h-3" /> Import
        </button>
        <input ref={fileRef} type="file" accept=".geojson,.json,.kml,.gpx,application/geo+json,application/vnd.google-earth.kml+xml,application/gpx+xml" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
        <span className="ml-auto text-[var(--text-muted)]">Export</span>
        <button onClick={() => exportAs('kml')} className="flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]" title="Bookmarks as KML (Google Earth)"><Download className="w-3 h-3" /> KML</button>
        <button onClick={() => exportAs('geojson')} className="flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]" title="Bookmarks as GeoJSON"><Download className="w-3 h-3" /> GeoJSON</button>
      </div>
      {importErr && <div className="px-3 pb-2 text-[10.5px] text-rose-400">{importErr}</div>}
      </>}
    </div>
  );
}
