// Client for server/shopping.py: price search, the basket with vendor cart links, and price watches.
import { req } from './api';

export interface Offer {
  url: string; host: string; vendor: string; vendorKey: string | null; title: string; price: number | null; currency: string;
  available: boolean | null; image: string | null; source: string | null; seller?: string | null; shipping?: number | null;
  cartId?: string; cart?: string; error?: string; note?: string | null; delivery?: string | null;
}
export interface BasketItem {
  id: string; url: string; vendor: string; host: string; title: string; price: number | null; currency: string; qty: number;
  cart_id: string | null; image: string | null; available: boolean | null; source: string | null; note: string | null;
  checked: boolean; price_ts: number | null; added: number;
}
export interface BasketGroup {
  host: string; vendor: string; items: BasketItem[]; subtotal: number; unpriced: number; cartKind: string | null;
  cartUrl: string | null; experimental: boolean; noCartLink: string[];
}
export interface Basket { groups: BasketGroup[]; total: number; currency: string; count: number }
export interface Watch {
  id: string; url: string; vendor: string; host: string; title: string; image: string | null; target: number | null; currency: string | null;
  price: number | null; low: number | null; available: boolean | null; source: string | null; checked: number | null; error: string | null;
  active: boolean; created: number; history: [number, number][];
}
export interface ShopSettings { watchHours: number; dropPercent: number }
export interface Vendor { key: string; name: string; host: string; cart: string | null; blocked: boolean }
export interface Overview { basket: Basket; watches: Watch[]; settings: ShopSettings; vendors: Vendor[] }
export interface SearchResult { query: string; vendors: string[]; offers: Offer[]; searched: number; at: number }

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const shopApi = {
  overview: () => req<Overview>('/api/shop'),
  search: (q: string, vendors: string[], maxPrice?: number) =>
    req<SearchResult>('/api/shop/search', { method: 'POST', ...json({ q, vendors, maxPrice, limit: 12 }) }),
  inspect: (url: string) => req<Offer>('/api/shop/inspect', { method: 'POST', ...json({ url }) }),
  add: (offer: Offer | null, url: string, qty = 1) =>
    req<{ item: BasketItem; basket: Basket }>('/api/shop/basket', { method: 'POST', ...json(offer ? { offer, qty } : { url, qty }) }),
  update: (id: string, patch: Partial<Pick<BasketItem, 'qty' | 'note' | 'checked'>>) =>
    req<Basket>(`/api/shop/basket/${id}`, { method: 'PATCH', ...json(patch) }),
  refresh: (id: string) => req<{ item: BasketItem & { error?: string }; basket: Basket }>(`/api/shop/basket/${id}/refresh`, { method: 'POST' }),
  remove: (id: string) => req<Basket>(`/api/shop/basket/${id}`, { method: 'DELETE' }),
  clear: (host = '', checked = false) =>
    req<Basket>(`/api/shop/basket?${new URLSearchParams({ host, checked: String(checked) })}`, { method: 'DELETE' }),
  watch: (url: string, target?: number | null) => req<Watch>('/api/shop/watch', { method: 'POST', ...json({ url, target }) }),
  updateWatch: (id: string, patch: { target?: number | null; active?: boolean }) =>
    req<Watch>(`/api/shop/watch/${id}`, { method: 'PATCH', ...json(patch) }),
  checkWatch: (id: string) => req<Watch & { news: string | null }>(`/api/shop/watch/${id}/check`, { method: 'POST' }),
  unwatch: (id: string) => req(`/api/shop/watch/${id}`, { method: 'DELETE' }),
  settings: (s: Partial<ShopSettings>) => req<ShopSettings>('/api/shop/settings', { method: 'PUT', ...json(s) }),
};

export function money(v: number | null | undefined, currency = 'USD'): string {
  if (v == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency && currency.length === 3 ? currency : 'USD' }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

/** Short label for where a price came from; snippet and model reads are the ones to double-check. */
export function sourceTag(source: string | null | undefined): { label: string; tone: 'sure' | 'check' | 'weak' } | null {
  if (!source) return null;
  if (source.startsWith('search snippet')) return { label: 'Snippet · unverified', tone: 'weak' };
  if (source.startsWith('page text')) return { label: 'Read from page', tone: 'check' };
  return { label: source.replace(/^\w/, c => c.toUpperCase()), tone: 'sure' };
}

export const CART_LABEL: Record<string, string> = { amazon: 'Amazon', shopify: 'store', walmart: 'Walmart' };
