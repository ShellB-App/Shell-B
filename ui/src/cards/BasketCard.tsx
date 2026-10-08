// ```basket``` fence (body ignored, usually {}): the live shopping basket from server/shopping.py, grouped by store, with the
// Send-to-cart links. Agents show it after adding items with the shop tool; edits here change the real basket.
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, ShoppingCart } from 'lucide-react';
import { BasketView } from '../components/Shopping';
import { money, shopApi, type Basket } from '../shopApi';
import { CardButton, CardFrame, CardPending } from './CardFrame';
import type { CardProps } from './registry';

export function BasketCard({ streaming }: CardProps) {
  const [basket, setBasket] = useState<Basket | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => shopApi.overview().then(d => { setBasket(d.basket); setError(''); }).catch(e => setError(String(e.message ?? e))), []);
  useEffect(() => { if (!streaming) load(); }, [streaming, load]);
  if (streaming || (!basket && !error)) return <CardPending icon={ShoppingCart} streaming waiting="Loading the basket…" broken="" />;
  if (!basket) return <CardPending icon={ShoppingCart} waiting="" broken={`Couldn't load the basket: ${error}`} />;
  return (
    <CardFrame icon={ShoppingCart} title="Shopping basket"
      meta={basket.count ? `${basket.count} item${basket.count === 1 ? '' : 's'} · ${basket.currency === 'mixed' ? 'mixed' : money(basket.total, basket.currency)}` : 'empty'}
      actions={<>
        <CardButton onClick={load} title="Reload"><RefreshCw className="w-3 h-3" /></CardButton>
        <CardButton onClick={() => { location.hash = '#/shop/basket'; }} title="Open in Shopping"><ExternalLink className="w-3 h-3" /></CardButton>
      </>}>
      <BasketView basket={basket} onChange={setBasket} compact />
    </CardFrame>
  );
}
