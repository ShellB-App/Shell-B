"""Shopping: price parsers, cart links, the basket and price-watch alerts, without touching the network."""
import asyncio
import json
import unittest
from unittest import mock

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import shopping


def ld(obj) -> str:
    return f'<html><head><title>x</title><script type="application/ld+json">{json.dumps(obj)}</script></head><body></body></html>'


class Parsers(unittest.TestCase):
    def test_jsonld_offer_and_graph(self):
        page = ld({"@graph": [{"@type": "WebPage"}, {"@type": "Product", "name": "Kettle", "brand": {"name": "Acme"}, "gtin13": "0123456789012",
                   "offers": {"@type": "Offer", "price": "1,299.99", "priceCurrency": "USD", "availability": "https://schema.org/InStock"}}]})
        o = shopping.from_jsonld(page, "https://shop.example/p/kettle")
        self.assertEqual((o["title"], o["price"], o["available"], o["brand"], o["gtin"]), ("Kettle", 1299.99, True, "Acme", "0123456789012"))

    def test_jsonld_aggregate_and_cheapest_in_stock(self):
        agg = ld({"@type": "Product", "name": "Cable", "offers": {"@type": "AggregateOffer", "lowPrice": 4.5, "highPrice": 9, "priceCurrency": "USD"}})
        self.assertEqual(shopping.from_jsonld(agg, "https://x.example/p/c")["price"], 4.5)
        many = ld({"@type": "Product", "name": "Pi", "offers": [
            {"@type": "Offer", "price": 40, "availability": "OutOfStock"}, {"@type": "Offer", "price": 50, "availability": "InStock"},
            {"@type": "Offer", "price": 45, "availability": "InStock"}]})
        self.assertEqual(shopping.from_jsonld(many, "https://x.example/p/pi")["price"], 45)

    def test_product_group_picks_requested_variant(self):
        page = ld({"@type": "ProductGroup", "name": "Shirt", "hasVariant": [
            {"@type": "Product", "name": "Shirt S", "offers": {"price": 20, "url": "https://s.example/products/shirt?variant=111"}},
            {"@type": "Product", "name": "Shirt M", "offers": {"price": 22, "url": "https://s.example/products/shirt?variant=222"}}]})
        self.assertEqual(shopping.from_jsonld(page, "https://s.example/products/shirt?variant=222")["price"], 22)

    def test_meta_tags(self):
        page = '<meta property="product:price:amount" content="19.95"><meta property="product:price:currency" content="EUR"><title>Mug</title>'
        o = shopping.from_meta(page)
        self.assertEqual((o["price"], o["currency"]), (19.95, "EUR"))

    def test_amazon_buy_box_and_no_offer(self):
        page = ('<span id="productTitle"> Widget </span><div class="a-section priceToPay"><span class="a-price-whole">199.</span>'
                '<span class="a-price-fraction">88</span><span class="a-offscreen"></span>$199.88</div><div id="availability"><span>In Stock</span></div>')
        o = shopping.from_amazon(page)
        self.assertEqual((o["title"], o["price"], o["available"]), ("Widget", 199.88, True))
        gone = shopping.from_amazon('<span id="productTitle">Widget</span><p>No featured offers available</p>')
        self.assertIsNone(gone["price"])
        self.assertFalse(gone["available"])

    def test_model_price_must_appear_in_page(self):
        self.assertTrue(shopping._appears(1299.99, "Now $1,299.99 free shipping"))
        self.assertFalse(shopping._appears(1199.99, "Now $1,299.99 free shipping"))

    def test_money(self):
        self.assertEqual(shopping.money("$1,234.50"), 1234.5)
        self.assertIsNone(shopping.money("0"))
        self.assertIsNone(shopping.money(True))


class Urls(unittest.TestCase):
    def test_vendor_ids_and_canonical(self):
        self.assertEqual(shopping.product_id("https://www.amazon.com/Anker-737/dp/B09VPHVT2Z/ref=sr_1_3?tag=x"), "B09VPHVT2Z")
        self.assertEqual(shopping.canonical("https://www.amazon.com/Anker-737/dp/B09VPHVT2Z/ref=sr_1_3?tag=x"), "https://www.amazon.com/dp/B09VPHVT2Z")
        self.assertEqual(shopping.product_id("https://www.walmart.com/ip/Some-Thing/4419416006"), "4419416006")
        self.assertEqual(shopping.canonical("https://store.example/products/shirt?variant=222&utm_source=x"), "https://store.example/products/shirt?variant=222")
        self.assertTrue(shopping.looks_like_product("https://www.bestbuy.com/site/anker-power-bank/6553403.p?skuId=6553403"))
        self.assertFalse(shopping.looks_like_product("https://www.amazon.com/s?k=anker"))
        self.assertFalse(shopping.looks_like_product("https://store.example/collections/all"))

    def test_cart_links(self):
        items = [{"cart_id": "B000000001", "qty": 2}, {"cart_id": "B000000002", "qty": 1}, {"cart_id": None, "qty": 1}]
        self.assertEqual(shopping.cart_link("amazon", "amazon.com", items),
                         "https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B000000001&Quantity.1=2&ASIN.2=B000000002&Quantity.2=1")
        self.assertEqual(shopping.cart_link("shopify", "allbirds.com", [{"cart_id": "31330825109584", "qty": 3}]),
                         "https://allbirds.com/cart/31330825109584:3")
        self.assertEqual(shopping.cart_link("walmart", "walmart.com", [{"cart_id": "123", "qty": 2}]),
                         "https://affil.walmart.com/cart/addToCart?items=123|2")
        self.assertIsNone(shopping.cart_link("amazon", "amazon.com", [{"cart_id": None, "qty": 1}]))


class BasketAndWatch(unittest.TestCase):
    def setUp(self):
        shopping.init()
        shopping.clear_basket()

    def test_basket_groups_merges_and_links(self):
        a = {"url": "https://www.amazon.com/x/dp/B000000001?ref=1", "vendor": "Amazon", "title": "Thing", "price": 10.0, "cartId": "B000000001"}
        shopping.add_to_basket(a, 1)
        shopping.add_to_basket(a, 2)   # same product: one line, qty 3
        shopping.add_to_basket({"url": "https://www.target.com/p/-/A-12345678", "vendor": "Target", "title": "Other", "price": 5.0}, 1)
        b = shopping.basket()
        amazon = next(g for g in b["groups"] if g["host"] == "amazon.com")
        self.assertEqual(amazon["items"][0]["qty"], 3)
        self.assertEqual(amazon["subtotal"], 30.0)
        self.assertIn("ASIN.1=B000000001&Quantity.1=3", amazon["cartUrl"])
        target = next(g for g in b["groups"] if g["host"] == "target.com")
        self.assertIsNone(target["cartUrl"])
        self.assertEqual(b["total"], 35.0)

    def test_basket_api_round_trip(self):
        offer = {"url": "https://shop.example/products/mug?variant=9", "vendor": "shop.example", "title": "Mug", "price": 12.0,
                 "cartId": "9", "source": "Shopify product data"}
        r = client.post("/api/shop/basket", json={"offer": offer, "qty": 2})
        self.assertEqual(r.status_code, 200, r.text)
        g = r.json()["basket"]["groups"][0]
        self.assertEqual(g["cartUrl"], "https://shop.example/cart/9:2")
        iid = g["items"][0]["id"]
        self.assertEqual(client.patch(f"/api/shop/basket/{iid}", json={"qty": 5}).json()["groups"][0]["items"][0]["qty"], 5)
        self.assertEqual(client.delete(f"/api/shop/basket/{iid}").json()["count"], 0)
        self.assertEqual(client.post("/api/shop/basket", json={"offer": {**offer, "url": "http://127.0.0.1:8200/x"}}).status_code, 400)

    def test_watch_alerts_on_target_drop_and_restock(self):
        prices = iter([{"price": 120.0, "available": True}, {"price": 99.0, "available": True}, {"price": 99.0, "available": True},
                       {"price": None, "available": False}, {"price": 101.0, "available": True}])

        async def fake(urls, snippets=None, browser_budget=0, use_model=True):
            return [{"url": urls[0], "title": "Speaker", "currency": "USD", "source": "structured data", **next(prices)}]
        posts = []
        with mock.patch.object(shopping, "inspect_many", fake), mock.patch.object(shopping.activity, "post", lambda *a, **k: posts.append(a)):
            w = asyncio.run(shopping.add_watch("https://audio.example/products/speaker", 100))
            try:
                self.assertEqual(w["price"], 120.0)
                self.assertEqual(asyncio.run(shopping.check_watch(w["id"]))["news"], "target")
                self.assertIsNone(asyncio.run(shopping.check_watch(w["id"]))["news"])   # still under target: no repeat
                self.assertIsNone(asyncio.run(shopping.check_watch(w["id"]))["news"])   # out of stock
                self.assertEqual(asyncio.run(shopping.check_watch(w["id"]))["news"], "restock")
            finally:
                shopping.remove_watch(w["id"])
        self.assertEqual([p[1] for p in posts], ["review", "review"])
        self.assertIn("$99.00", posts[0][2])


if __name__ == "__main__":
    unittest.main()
