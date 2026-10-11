import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Bell, BellOff, Check, ExternalLink, Loader2, Minus, PackageSearch, Plus, RefreshCw, Search, ShoppingCart,
  Trash2, TrendingDown } from 'lucide-react';
import { CART_LABEL, money, shopApi, sourceTag, type Basket, type BasketGroup, type Offer, type Overview, type Watch } from '../shopApi';
import { btn, relTime } from './common';
import { t as tx } from '../i18n';

/** Shopping (#/shop): compare prices, keep a basket that goes to each store as a cart link, and watch prices.
 *  Everything comes from server/shopping.py; Shell:B never signs in to a store or checks out. */

type Tab = 'find' | 'basket' | 'watch';
const readTab = (): Tab => { const m = /^#\/shop\/(basket|watch)\b/.exec(location.hash); return (m?.[1] as Tab) ?? 'find'; };

const QUICK_STORES = ['amazon', 'walmart', 'target', 'bestbuy', 'ebay', 'newegg', 'bh', 'microcenter', 'costco', 'digikey', 'mouser', 'adafruit'];

export function Shopping() {
  const [tab, setTab] = useState<Tab>(readTab);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => shopApi.overview().then(d => { setData(d); setError(''); }).catch(e => setError(String(e.message ?? e))), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const on = () => setTab(readTab());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const go = (t: Tab) => { location.hash = t === 'find' ? '#/shop' : `#/shop/${t}`; };
  const setBasket = (basket: Basket) => setData(d => d && { ...d, basket });

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'find', label: 'Find' },
    { id: 'basket', label: 'Basket', count: data?.basket.count },
    { id: 'watch', label: 'Watching', count: data?.watches.length },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <header className="flex flex-wrap items-end gap-4 mb-6">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight leading-tight">{tx('Shopping')}</h1>
            <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-[65ch]">
              {tx('Prices are read from each store’s product page. The basket goes to every store as a cart link that opens in your browser, so items land in your own cart. Shell:B never signs in or checks out.')}
            </p>
          </div>
          <div className="flex-1" />
          <nav className="flex gap-1 rounded-lg border border-[var(--border-subtle)] p-0.5 bg-[var(--bg-secondary)]" role="tablist">
            {tabs.map(t => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)}
                className={clsx('px-3 py-1.5 rounded-md text-xs font-medium transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]',
                  tab === t.id ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
                {tx(t.label)}{t.count ? <span className="ml-1.5 tabular-nums text-[var(--text-muted)]">{t.count}</span> : null}
              </button>
            ))}
          </nav>
        </header>
        {error && <p className="mb-4 text-sm text-red-500 flex items-center gap-2"><AlertTriangle className="w-4 h-4" />{error}</p>}
        {tab === 'find' && <Finder onBasket={b => setBasket(b)} onWatch={load} />}
        {tab === 'basket' && (data ? <BasketView basket={data.basket} onChange={setBasket} /> : <Skeleton rows={3} />)}
        {tab === 'watch' && (data ? <WatchList data={data} reload={load} /> : <Skeleton rows={3} />)}
      </div>
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return <div className="space-y-2">{Array.from({ length: rows }, (_, i) =>
    <div key={i} className="h-16 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] animate-pulse" />)}</div>;
}

function Thumb({ src }: { src: string | null }) {
  const [bad, setBad] = useState(false);
  return (
    <div className="w-12 h-12 shrink-0 rounded-md border border-[var(--border-subtle)] bg-white/90 overflow-hidden grid place-items-center">
      {src && !bad ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} className="max-w-full max-h-full object-contain" />
        : <PackageSearch className="w-5 h-5 text-zinc-400" />}
    </div>
  );
}

function SourceTag({ source }: { source: string | null | undefined }) {
  const t = sourceTag(source);
  if (!t) return null;
  return (
    <span title={source ?? ''} className={clsx('text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 border',
      t.tone === 'sure' && 'border-[var(--border-subtle)] text-[var(--text-muted)]',
      t.tone === 'check' && 'border-sky-500/30 text-sky-600 dark:text-sky-400',
      t.tone === 'weak' && 'border-amber-500/40 text-amber-600 dark:text-amber-400')}>{tx(t.label)}</span>
  );
}

function Stock({ available }: { available: boolean | null }) {
  if (available === null || available === undefined) return null;
  return available ? <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{tx('In stock')}</span>
    : <span className="text-[11px] text-red-500">{tx('Out of stock')}</span>;
}

// ── Find ──────────────────────────────────────────────────────────────────

function Finder({ onBasket, onWatch }: { onBasket: (b: Basket) => void; onWatch: () => void }) {
  const [q, setQ] = useState('');
  const [stores, setStores] = useState<string[]>([]);
  const [maxPrice, setMaxPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ query: string; offers: Offer[]; searched: number } | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Record<string, 'basket' | 'watch'>>({});

  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true); setError(''); setDone({});
    try {
      if (/^https?:\/\//i.test(text)) {
        const o = await shopApi.inspect(text);
        setResult({ query: text, offers: [o], searched: 1 });
      } else {
        setResult(await shopApi.search(text, stores, Number(maxPrice) || undefined));
      }
    } catch (err) { setError(String((err as Error).message ?? err)); }
    setBusy(false);
  };
  const toggle = (k: string) => setStores(s => s.includes(k) ? s.filter(x => x !== k) : [...s, k]);
  const add = async (o: Offer) => {
    const r = await shopApi.add(o, o.url);
    onBasket(r.basket); setDone(d => ({ ...d, [o.url]: 'basket' }));
  };
  const watch = async (o: Offer) => {
    await shopApi.watch(o.url, null);
    onWatch(); setDone(d => ({ ...d, [o.url]: 'watch' }));
  };
  const best = result?.offers.find(o => o.price != null && o.available !== false);

  return (
    <section>
      <form onSubmit={run} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4">
        <div className="flex gap-2">
          <label className="relative flex-1">
            <span className="sr-only">{tx('Product or product link')}</span>
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={tx('Model, size, pack count… or paste a product link')}
              className={clsx(btn.input, 'pl-8 py-2')} autoFocus />
          </label>
          <input value={maxPrice} onChange={e => setMaxPrice(e.target.value.replace(/[^\d.]/g, ''))} placeholder={tx('Max $')} inputMode="decimal"
            aria-label={tx('Maximum price')} className={clsx(btn.input, 'w-24 py-2')} />
          <button type="submit" className={clsx(btn.primary, 'px-4')} disabled={busy || !q.trim()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}{tx('Compare prices')}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] mr-1">{tx('Stores')}</span>
          <button type="button" onClick={() => setStores([])} aria-pressed={!stores.length}
            className={clsx('px-2 py-0.5 rounded-md text-xs border transition', !stores.length ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
            {tx('Anywhere')}</button>
          {QUICK_STORES.map(k => (
            <button type="button" key={k} onClick={() => toggle(k)} aria-pressed={stores.includes(k)}
              className={clsx('px-2 py-0.5 rounded-md text-xs border transition', stores.includes(k) ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
              {STORE_NAME[k] ?? k}</button>
          ))}
        </div>
      </form>

      {busy && (
        <div className="mt-6">
          <p className="text-sm text-[var(--text-secondary)] flex items-center gap-2 mb-3"><Loader2 className="w-4 h-4 animate-spin" />
            {tx('Searching, then reading each product page. Stores that block plain requests open in a headless browser, so this takes 20–60 s.')}</p>
          <Skeleton rows={4} />
        </div>
      )}
      {error && !busy && <p className="mt-4 text-sm text-red-500">{error}</p>}
      {result && !busy && (
        <div className="mt-6">
          <div className="flex items-baseline gap-3 mb-3">
            <h2 className="text-base font-semibold tracking-tight">{result.offers.length} offer{result.offers.length === 1 ? '' : 's'}</h2>
            <span className="text-xs text-[var(--text-muted)]">{tx('cheapest first, from')} {result.searched} {tx('product page')}{result.searched === 1 ? '' : 's'} {tx('· before tax')}</span>
          </div>
          {!result.offers.length && <p className="text-sm text-[var(--text-secondary)] max-w-[65ch]">{tx('No product pages turned up. Try the exact model number, or pick other stores.')}</p>}
          <ol className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)] overflow-hidden">
            {result.offers.map(o => (
              <li key={o.url} className={clsx('flex items-center gap-3 px-3 py-3 bg-[var(--bg-secondary)]', o === best && 'bg-emerald-500/[0.04]')}>
                <Thumb src={o.image} />
                <div className="min-w-0 flex-1">
                  <a href={o.url} target="_blank" rel="noopener noreferrer" className="text-sm leading-snug line-clamp-2 hover:underline">{o.title || o.url}</a>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs text-[var(--text-secondary)]">
                    <span className="font-medium text-[var(--text-primary)]">{o.vendor}</span>
                    {o.seller && o.seller !== o.vendor && <span>{tx('sold by {seller}', { seller: o.seller })}</span>}
                    <Stock available={o.available} />
                    <SourceTag source={o.source} />
                    {(o.error || o.note) && <span className="text-[var(--text-muted)]">{o.error || o.note}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0 w-28">
                  <div className={clsx('text-lg font-semibold tabular-nums tracking-tight', o.price == null && 'text-[var(--text-muted)]')}>{money(o.price, o.currency)}</div>
                  {o.shipping != null && <div className="text-[11px] text-[var(--text-muted)]">{o.shipping === 0 ? tx('free shipping') : tx('+ {v0} ship', { v0: money(o.shipping, o.currency) })}</div>}
                  {o === best && <div className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">{tx('Best price')}</div>}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button className={btn.subtle} onClick={() => add(o)} disabled={done[o.url] === 'basket'}>
                    {done[o.url] === 'basket' ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}{done[o.url] === 'basket' ? tx('Added') : tx('Basket')}</button>
                  <button className={btn.ghost} onClick={() => watch(o)} disabled={done[o.url] === 'watch'}>
                    <Bell className="w-3.5 h-3.5" />{done[o.url] === 'watch' ? tx('Watching') : tx('Watch')}</button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {!result && !busy && (
        <p className="mt-6 text-sm text-[var(--text-secondary)] max-w-[65ch] leading-relaxed">
          {tx('You can also ask in any chat: “find the cheapest 2-pack of Brita Elite filters and add it to my basket.” Agents that can search the web have a')} <code className="text-xs">shop</code> {tx('tool for this.')}
        </p>
      )}
    </section>
  );
}

const STORE_NAME: Record<string, string> = { amazon: 'Amazon', walmart: 'Walmart', target: 'Target', bestbuy: 'Best Buy', ebay: 'eBay', newegg: 'Newegg',
  bh: 'B&H', microcenter: 'Micro Center', costco: 'Costco', digikey: 'DigiKey', mouser: 'Mouser', adafruit: 'Adafruit' };

// ── Basket ────────────────────────────────────────────────────────────────

/** The basket grouped by store. Also rendered by the ```basket``` chat card (compact). */
export function BasketView({ basket, onChange, compact }: { basket: Basket; onChange: (b: Basket) => void; compact?: boolean }) {
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const addUrl = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true); setErr('');
    try { onChange((await shopApi.add(null, url.trim())).basket); setUrl(''); } catch (x) { setErr(String((x as Error).message ?? x)); }
    setAdding(false);
  };
  return (
    <div className={compact ? '' : 'space-y-4'}>
      {!compact && (
        <form onSubmit={addUrl} className="flex gap-2">
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder={tx('Paste a product link to add it')} className={clsx(btn.input, 'py-2')} aria-label={tx('Product link')} />
          <button className={btn.subtle} disabled={adding || !url.trim()}>{adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}{tx('Add')}</button>
        </form>
      )}
      {err && <p className="text-sm text-red-500">{err}</p>}
      {!basket.groups.length ? (
        <div className={clsx('text-sm text-[var(--text-secondary)]', compact ? 'px-3 py-4' : 'rounded-xl border border-dashed border-[var(--border-subtle)] px-6 py-10 text-center')}>
          <ShoppingCart className={clsx('w-6 h-6 mx-auto mb-2 text-[var(--text-muted)]', compact && 'hidden')} />
          {tx('The basket is empty. Add offers from Find, paste a link above, or ask an agent to shop for you.')}
        </div>
      ) : (
        <>
          {basket.groups.map(g => <StoreGroup key={g.host} g={g} onChange={onChange} compact={compact} />)}
          <div className={clsx('flex items-baseline gap-3', compact ? 'px-3 py-2 border-t border-[var(--border-subtle)]' : 'px-1')}>
            <span className="text-xs text-[var(--text-muted)]">{basket.count} item{basket.count === 1 ? '' : 's'} · {basket.groups.length} store{basket.groups.length === 1 ? '' : 's'} {tx('· before tax and shipping')}</span>
            <div className="flex-1" />
            <span className="text-xs uppercase tracking-wider text-[var(--text-muted)]">{tx('Total')}</span>
            <span className="text-lg font-semibold tabular-nums tracking-tight">{basket.currency === 'mixed' ? tx('mixed currencies') : money(basket.total, basket.currency)}</span>
          </div>
          {!compact && (
            <div className="flex justify-end gap-2">
              <button className={btn.ghost} onClick={async () => onChange(await shopApi.clear('', true))}><Check className="w-3.5 h-3.5" />{tx('Clear items marked added')}</button>
              <button className={btn.ghost} onClick={async () => { if (confirm(tx('Empty the whole basket?'))) onChange(await shopApi.clear()); }}><Trash2 className="w-3.5 h-3.5" />{tx('Empty basket')}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StoreGroup({ g, onChange, compact }: { g: BasketGroup; onChange: (b: Basket) => void; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, fn: () => Promise<Basket>) => { setBusy(id); try { onChange(await fn()); } finally { setBusy(null); } };
  const allLinked = g.cartUrl && !g.noCartLink.length;
  return (
    <section className={clsx(!compact && 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden', compact && 'border-b border-[var(--border-subtle)] last:border-b-0')}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 border-b border-[var(--border-subtle)]">
        <h3 className="text-sm font-semibold tracking-tight">{g.vendor}</h3>
        <span className="text-xs tabular-nums text-[var(--text-secondary)]">{money(g.subtotal, g.items[0]?.currency)}{g.unpriced ? tx(' + {unpriced} unpriced', { unpriced: g.unpriced }) : ''}</span>
        <div className="flex-1" />
        {g.cartUrl ? (
          <a href={g.cartUrl} target="_blank" rel="noopener noreferrer" className={btn.primary}
            title={g.experimental ? tx('Walmart doesn’t document this link; if it fails, add the items from their links') : tx('Opens the store in your browser and adds these items to your cart there')}>
            <ShoppingCart className="w-3.5 h-3.5" />{tx('Send to')} {CART_LABEL[g.cartKind ?? ''] ?? g.vendor} cart{g.experimental ? ' (beta)' : ''}
          </a>
        ) : (
          <span className="text-[11px] text-[var(--text-muted)]">{tx('No cart link for this store: open each item below')}</span>
        )}
      </header>
      {g.cartUrl && !allLinked && <p className="px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 border-b border-[var(--border-subtle)]">{tx('{length} item(s) have no cart id and need adding by hand.', { length: g.noCartLink.length })}</p>}
      <ul className="divide-y divide-[var(--border-subtle)]">
        {g.items.map(i => (
          <li key={i.id} className={clsx('flex items-center gap-3 px-3 py-2', i.checked && 'opacity-60')}>
            {!g.cartUrl && (
              <input type="checkbox" checked={i.checked} onChange={e => act(i.id, () => shopApi.update(i.id, { checked: e.target.checked }))}
                title={tx('Mark as added to the store\'s cart')} className="accent-[var(--accent)]" />
            )}
            {!compact && <Thumb src={i.image} />}
            <div className="min-w-0 flex-1">
              <a href={i.url} target="_blank" rel="noopener noreferrer" className={clsx('text-sm leading-snug hover:underline', compact ? 'line-clamp-1' : 'line-clamp-2')}>{tx(i.title)}</a>
              <div className="flex flex-wrap items-center gap-2 mt-0.5 text-[11px] text-[var(--text-muted)]">
                {i.available === false && <span className="text-red-500">{tx('Out of stock')}</span>}
                {!compact && <SourceTag source={i.source} />}
                {i.price_ts && <span>price {relTime(i.price_ts * 1000)}</span>}
                {i.note && <span className="text-[var(--text-secondary)]">{tx(i.note)}</span>}
              </div>
            </div>
            <div className="flex items-center rounded-md border border-[var(--border-subtle)]" aria-label={tx('Quantity')}>
              <button className="px-1.5 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30" disabled={i.qty <= 1 || !!busy}
                onClick={() => act(i.id, () => shopApi.update(i.id, { qty: i.qty - 1 }))} aria-label={tx('One fewer')}><Minus className="w-3 h-3" /></button>
              <span className="w-6 text-center text-xs tabular-nums">{i.qty}</span>
              <button className="px-1.5 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30" disabled={!!busy}
                onClick={() => act(i.id, () => shopApi.update(i.id, { qty: i.qty + 1 }))} aria-label={tx('One more')}><Plus className="w-3 h-3" /></button>
            </div>
            <span className="w-20 text-right text-sm tabular-nums">{money(i.price == null ? null : i.price * i.qty, i.currency)}</span>
            {!compact && (
              <button className={btn.icon} title={tx('Recheck the price')} disabled={!!busy}
                onClick={() => act(i.id, async () => (await shopApi.refresh(i.id)).basket)}>
                <RefreshCw className={clsx('w-3.5 h-3.5', busy === i.id && 'animate-spin')} /></button>
            )}
            <button className={btn.icon} title={tx('Remove')} disabled={!!busy} onClick={() => act(i.id, () => shopApi.remove(i.id))}><Trash2 className="w-3.5 h-3.5" /></button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Watching ──────────────────────────────────────────────────────────────

function Spark({ points, target }: { points: [number, number][]; target: number | null }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const ys = points.map(p => p[1]).concat(target ?? []);
    const lo = Math.min(...ys), hi = Math.max(...ys), t0 = points[0][0], t1 = points[points.length - 1][0];
    const x = (t: number) => t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * 116 + 2;
    const y = (v: number) => hi === lo ? 14 : 26 - ((v - lo) / (hi - lo)) * 24;
    return { d: points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(''), ty: target != null ? y(target) : null };
  }, [points, target]);
  if (!path) return <span className="w-[120px] text-[11px] text-[var(--text-muted)]">{tx('history builds up')}</span>;
  return (
    <svg width="120" height="28" viewBox="0 0 120 28" aria-hidden className="shrink-0">
      {path.ty != null && <line x1="0" x2="120" y1={path.ty} y2={path.ty} stroke="currentColor" strokeDasharray="2 3" className="text-emerald-500/60" />}
      <path d={path.d} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--accent)]" />
    </svg>
  );
}

function WatchList({ data, reload }: { data: Overview; reload: () => void }) {
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setErr('');
    try { await fn(); reload(); } catch (x) { setErr(String((x as Error).message ?? x)); }
    setBusy(null);
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) run('add', async () => { await shopApi.watch(url.trim(), Number(target) || null); setUrl(''); setTarget(''); });
  };
  const s = data.settings;
  return (
    <section className="space-y-4">
      <form onSubmit={add} className="flex gap-2">
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder={tx('Product link to watch')} className={clsx(btn.input, 'py-2')} aria-label={tx('Product link')} />
        <input value={target} onChange={e => setTarget(e.target.value.replace(/[^\d.]/g, ''))} placeholder={tx('Target $')} inputMode="decimal" aria-label={tx('Target price')} className={clsx(btn.input, 'w-28 py-2')} />
        <button className={btn.subtle} disabled={busy === 'add' || !url.trim()}>{busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}{tx('Watch')}</button>
      </form>
      {err && <p className="text-sm text-red-500">{err}</p>}
      {!data.watches.length ? (
        <div className="rounded-xl border border-dashed border-[var(--border-subtle)] px-6 py-10 text-center text-sm text-[var(--text-secondary)]">
          <TrendingDown className="w-6 h-6 mx-auto mb-2 text-[var(--text-muted)]" />
          {tx('Nothing watched yet. Watch an offer from Find or paste a link. You get a notification when it reaches your target, drops by')} {s.dropPercent}{tx('% or comes back in stock.')}
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
          {data.watches.map(w => <WatchRow key={w.id} w={w} busy={busy === w.id} run={fn => run(w.id, fn)} />)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)] px-1">
        <label className="flex items-center gap-1.5">{tx('Recheck every')}
          <select value={s.watchHours} onChange={e => run('s', () => shopApi.settings({ watchHours: Number(e.target.value) }))} className={clsx(btn.input, 'w-auto py-0.5 text-xs')}>
            {[3, 6, 12, 24, 48].map(h => <option key={h} value={h}>{h} hours</option>)}
          </select></label>
        <label className="flex items-center gap-1.5">{tx('Alert on drops of')}
          <select value={s.dropPercent} onChange={e => run('s', () => shopApi.settings({ dropPercent: Number(e.target.value) }))} className={clsx(btn.input, 'w-auto py-0.5 text-xs')}>
            {[3, 5, 10, 15, 25].map(p => <option key={p} value={p}>{p}%</option>)}
          </select> {tx('or more')}</label>
        <span className="text-[var(--text-muted)]">{tx('Alerts go to Activity and, if enabled, push notifications (Settings → Notifications → Price watch).')}</span>
      </div>
    </section>
  );
}

function WatchRow({ w, busy, run }: { w: Watch; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const [target, setTarget] = useState(w.target?.toString() ?? '');
  useEffect(() => setTarget(w.target?.toString() ?? ''), [w.target]);
  const hit = w.target != null && w.price != null && w.price <= w.target;
  const saveTarget = () => { if ((Number(target) || null) !== w.target) run(() => shopApi.updateWatch(w.id, { target: Number(target) || null })); };
  return (
    <li className={clsx('flex flex-wrap sm:flex-nowrap items-center gap-3 px-3 py-3', !w.active && 'opacity-55')}>
      <Thumb src={w.image} />
      <div className="min-w-0 flex-1 basis-56">
        <a href={w.url} target="_blank" rel="noopener noreferrer" className="text-sm leading-snug line-clamp-2 hover:underline">{w.title || w.url}</a>
        <div className="flex flex-wrap items-center gap-2 mt-0.5 text-[11px] text-[var(--text-muted)]">
          <span className="text-[var(--text-secondary)] font-medium">{w.vendor}</span>
          <Stock available={w.available} />
          <span>{w.checked ? tx('checked {v0}', { v0: relTime(w.checked * 1000) }) : tx('not checked yet')}</span>
          {w.error && <span className="text-amber-600 dark:text-amber-400">{w.error}</span>}
        </div>
      </div>
      <Spark points={w.history} target={w.target} />
      <Stat label={tx('Now')} value={money(w.price, w.currency ?? 'USD')} strong tone={hit ? 'good' : undefined} />
      <Stat label="Low" value={money(w.low, w.currency ?? 'USD')} />
      <label className="flex flex-col items-end">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{tx('Target')}</span>
        <input value={target} onChange={e => setTarget(e.target.value.replace(/[^\d.]/g, ''))} onBlur={saveTarget}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} placeholder="none" inputMode="decimal"
          className="w-20 bg-transparent text-right text-sm tabular-nums border-b border-[var(--border-subtle)] focus:outline-none focus:border-[var(--accent)]" />
      </label>
      <div className="flex items-center">
        <button className={btn.icon} title={tx('Check the price now')} disabled={busy} onClick={() => run(() => shopApi.checkWatch(w.id))}>
          <RefreshCw className={clsx('w-3.5 h-3.5', busy && 'animate-spin')} /></button>
        <button className={btn.icon} title={w.active ? tx('Pause') : tx('Resume')} disabled={busy} onClick={() => run(() => shopApi.updateWatch(w.id, { active: !w.active }))}>
          {w.active ? <BellOff className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}</button>
        <a className={btn.icon} href={w.url} target="_blank" rel="noopener noreferrer" title={tx('Open the product page')}><ExternalLink className="w-3.5 h-3.5" /></a>
        <button className={btn.icon} title={tx('Stop watching')} disabled={busy} onClick={() => run(() => shopApi.unwatch(w.id))}><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </li>
  );
}

function Stat({ label, value, strong, tone }: { label: string; value: ReactNode; strong?: boolean; tone?: 'good' }) {
  return (
    <div className="text-right w-20 shrink-0">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className={clsx('tabular-nums', strong ? 'text-base font-semibold tracking-tight' : 'text-sm text-[var(--text-secondary)]', tone === 'good' && 'text-emerald-600 dark:text-emerald-400')}>{value}</div>
    </div>
  );
}
