#!/usr/bin/env python3
"""Shell:B Screen helper: lets Shell:B look at this computer's screen, and use a browser window on it, when an agent
asks to.

Run it on your own computer while you want Shell:B to be able to do that; stop it (Ctrl+C) and she can't. It acts only
when an agent asks, and prints a line each time. Nothing is sent otherwise.

  pip install mss pillow playwright        (mss: screen, playwright: browser; either one is enough)
  python shellb_screen.py

Browser: Shell:B gets her own Chrome window (Edge, or Playwright's Chromium, if Chrome isn't installed: then run
`python -m playwright install chromium` once). It has its own profile in ~/.shellb-browser, separate from your normal
browser, so she sees none of your usual logins; sign in to sites in that window yourself when she needs an account,
and they stay signed in. She reads pages and fills forms there; anything that submits, sends, buys or deletes waits
for your approval in the chat first. Close the window or stop this helper to take it away.

Settings → Screen → "Pair a computer" downloads a copy with the address and the device token filled in. Otherwise
pass --url https://<device>.<tailnet>.ts.net:8443 --token sbs_...  Unpairing it in Settings revokes the token.
The address must be one this computer can reach directly, e.g. the Tailscale HTTPS one; addresses behind Cloudflare
Access need a browser login and won't work here.
"""
import argparse
import base64
import io
import json
import platform
import queue
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = ""
DEFAULT_TOKEN = ""
DEFAULT_NAME = ""


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def say(msg):
    print(f"{time.strftime('%H:%M:%S')}  {msg}", flush=True)


try:
    import mss
    import mss.tools
except ImportError:
    mss = None
try:
    from PIL import Image
except ImportError:
    Image = None
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


class Client:
    def __init__(self, url, token):
        self.url, self.token = url.rstrip("/"), token

    def call(self, method, path, body=None, data=None, ctype="application/json", timeout=30, headers=None):
        h = {"x-shellb-screen": self.token, "user-agent": "shellb-screen/2"}
        h.update(headers or {})
        if body is not None:
            data = json.dumps(body).encode()
        if data is not None:
            h["content-type"] = ctype
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"null")


# ── screen ──────────────────────────────────────────────────────────────────

def monitors(sct):
    return [{"w": m["width"], "h": m["height"]} for m in sct.monitors[1:]]


def grab(sct, monitor, max_edge):
    mons = sct.monitors  # [0] = every monitor together, [1] = primary, ...
    n = 1 if monitor is None else max(0, min(int(monitor), len(mons) - 1))
    shot = sct.grab(mons[n])
    if Image is None:
        return mss.tools.to_png(shot.rgb, shot.size), "image/png", n, shot.size
    im = Image.frombytes("RGB", shot.size, shot.rgb)
    if max(im.size) > max_edge:
        k = max_edge / max(im.size)
        im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return buf.getvalue(), "image/jpeg", n, shot.size


# ── browser ─────────────────────────────────────────────────────────────────

# a small corner badge on every page of Shell:B's window, so it's never mistaken for your own browser
BADGE_JS = r"""(() => {
  if (window.top !== window) return;
  const add = () => {
    if (document.getElementById('__shellb_badge')) return;
    const d = document.createElement('div');
    d.id = '__shellb_badge';
    d.textContent = '✦ Shell:B can use this window';
    d.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:2147483647;pointer-events:none;font:600 12px system-ui,sans-serif;padding:6px 10px;border-radius:8px;background:rgba(17,17,27,.85);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    document.documentElement.appendChild(d);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();"""

# helpers shared by the page scripts below
COMMON_JS = r"""
const SENSITIVE = /(card.?num|cc.?num|cvv|cvc|csc|security.?code|ssn|social.?security|iban|routing|account.?num|\bpin\b|passw)/i;
const nameOf = (el) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().replace(/\s*[:*]+$/, '');
  const aria = clean(el.getAttribute('aria-label')); if (aria) return aria;
  const lb = el.getAttribute('aria-labelledby');
  if (lb) { const t = clean(lb.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ')); if (t) return t; }
  if (el.labels && el.labels.length) {  // a label's own words, not the options or values of the field inside it
    let t = '';
    for (const l of el.labels) { const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); while (w.nextNode()) if (!w.currentNode.parentElement.closest('select,textarea,option,button')) t += w.currentNode.nodeValue + ' '; }
    t = clean(t);
    const legend = el.type === 'radio' ? clean(el.closest('fieldset')?.querySelector('legend')?.innerText) : '';
    if (t) return legend ? `${legend}: ${t}` : t;
  }
  const tag = el.tagName;
  if (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
  if (tag === 'IMG') return clean(el.alt);
  if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) { const t = clean(el.innerText); if (t) return t.slice(0, 100); }
  return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.querySelector?.('img[alt]')?.alt || '');
};
const sensitive = (el) => {
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  return el.type === 'password' || /^cc-(number|csc|exp)/.test(ac) || /password/.test(ac)
    || SENSITIVE.test([el.name, el.id, ac, el.getAttribute('aria-label') || ''].join(' '));
};
const shown = (el) => {
  if (el.type === 'password') return el.value ? `•••• (${el.value.length} chars)` : '';
  if (sensitive(el) && el.value) return '••••' + el.value.replace(/\s/g, '').slice(-4);
  return el.value;
};
const roleOf = (el) => {
  const r = el.getAttribute('role'); if (r) return r;
  const tag = el.tagName.toLowerCase(), t = (el.getAttribute('type') || 'text').toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') return ['submit', 'button', 'reset', 'image'].includes(t) ? 'button' : ['checkbox', 'radio', 'range', 'file', 'color'].includes(t) ? t : 'textbox';
  if (el.isContentEditable) return 'textbox';
  return 'clickable';
};
const formFields = (form) => {
  const out = [];
  if (!form) return out;
  for (const el of form.querySelectorAll('input, select, textarea')) {
    const t = (el.type || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(t)) continue;
    if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
    const v = el.tagName === 'SELECT' ? [...el.selectedOptions].map(o => o.text).join(', ') : (t === 'checkbox' || t === 'radio') ? 'checked' : shown(el);
    if (v) out.push([nameOf(el) || el.name || t, v]);
  }
  return out;
};
"""

READ_JS = "(args) => {" + COMMON_JS + r"""
  const MAX = args.max || 12000, prefix = args.prefix || '';
  if (!window.__sbNext) window.__sbNext = 1;
  const lines = []; let len = 0, cut = false, buf = '', mute = 0;
  const push = (s) => { if (cut || !s) return; if (len + s.length > MAX) { cut = true; return; } lines.push(s); len += s.length + 1; };
  const flush = () => { const t = buf.replace(/\s+/g, ' ').trim(); buf = ''; if (t) push(t.length > 600 ? t.slice(0, 600) + '…' : t); };
  const INTER = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[contenteditable=""],[contenteditable=true],[onclick]';
  const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/;
  const q = (s) => JSON.stringify(s.length > 120 ? s.slice(0, 120) + '…' : s);
  const visible = (el) => el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  let seen = 0;
  const line = (el) => {
    if (!el.dataset.sb) el.dataset.sb = String(window.__sbNext++);
    const ref = prefix + el.dataset.sb, role = roleOf(el), tag = el.tagName.toLowerCase();
    let s = `[${ref}] ${role} ${q(nameOf(el))}`;
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (role === 'link') { const h = el.getAttribute('href') || ''; if (h && !h.startsWith('javascript:')) s += ' -> ' + (h.length > 80 ? h.slice(0, 80) + '…' : h); }
    if (tag === 'input' && t && !['text', 'submit', 'button', 'checkbox', 'radio'].includes(t)) s += ` type=${t}`;
    if (role === 'checkbox' || role === 'radio' || role === 'switch') s += ` checked=${el.checked ?? el.getAttribute('aria-checked') === 'true'}`;
    else if (tag === 'select') {
      const opts = [...el.options].map(o => o.text.trim()).filter(Boolean);
      s += ` value=${q([...el.selectedOptions].map(o => o.text.trim()).join(', '))} options: ${opts.slice(0, 25).join(' | ')}${opts.length > 25 ? ` (+${opts.length - 25} more)` : ''}`;
    } else if (role === 'textbox' || role === 'combobox' || role === 'searchbox' || ['input', 'textarea'].includes(tag) && role !== 'button') {
      const v = el.isContentEditable && tag !== 'input' ? el.innerText.trim() : shown(el);
      s += ` value=${q(v || '')}`;
      const ph = el.getAttribute('placeholder'); if (ph && ph !== nameOf(el)) s += ` placeholder=${q(ph)}`;
      if (sensitive(el)) s += ' (sensitive)';
    }
    if (el.required || el.getAttribute('aria-required') === 'true') s += ' required';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' disabled';
    if (el.readOnly) s += ' readonly';
    if (el.getAttribute('aria-invalid') === 'true' || (el.validity && !el.validity.valid && el.value)) s += ` invalid${el.validationMessage ? ' ' + q(el.validationMessage) : ''}`;
    if (role === 'button' && (el.form || el.closest('form')) && (tag === 'input' ? ['submit', 'image'].includes(t) : !t || t === 'submit')) s += ' (submits form)';
    push(s);
  };
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (cut || ++seen > 8000) return;
      if (ch.nodeType === 3) { if (!mute) buf += ch.nodeValue; continue; }
      if (ch.nodeType !== 1) continue;
      const el = ch, tag = el.tagName;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD|META|LINK)$/.test(tag) || el.id === '__shellb_badge') continue;
      if (!visible(el) && !(tag === 'INPUT' && /^(checkbox|radio)$/.test(el.type) && getComputedStyle(el).display !== 'none')) continue;
      if (/^H[1-6]$/.test(tag)) { flush(); push('#'.repeat(+tag[1]) + ' ' + el.innerText.replace(/\s+/g, ' ').trim()); continue; }
      if (tag === 'IFRAME' || tag === 'FRAME') { flush(); push(`(frame: ${el.title || el.name || el.src || 'embedded'})`); continue; }
      if (tag === 'BR') { flush(); continue; }
      if (el.matches(INTER)) { flush(); line(el); if (!['SELECT', 'TEXTAREA'].includes(tag) && el.isContentEditable === false && el.querySelector(INTER)) walk(el); continue; }
      if (tag === 'LABEL' && el.control) {  // the field's line carries the label's words
        if (!el.contains(el.control)) continue;
        flush(); mute++; walk(el); mute--; continue;
      }
      if (el.shadowRoot) walk(el.shadowRoot);
      const block = BLOCK.test(getComputedStyle(el).display);
      if (block) flush();
      walk(el);
      if (block) flush();
    }
  };
  walk(document.body || document.documentElement);
  flush();
  return { lines, cut, title: document.title, url: location.href };
}"""

DESCRIBE_JS = "(el) => {" + COMMON_JS + r"""
  const tag = el.tagName.toLowerCase(), t = (el.getAttribute('type') || '').toLowerCase(), role = roleOf(el);
  const form = el.form || el.closest('form');
  const name = nameOf(el);
  const submitButton = role === 'button' && !!form && (tag === 'input' ? ['submit', 'image'].includes(t) : tag === 'button' ? (!t || t === 'submit') : false);
  const realLink = tag === 'a' && /^(https?:|\/|\.|[a-z0-9])/i.test(el.getAttribute('href') || '') && !el.hasAttribute('data-method');
  const COMMIT = /\b(submit|send|pay|buy|purchase|order|check ?out|confirm|delete|remove|book|reserve|subscribe|unsubscribe|transfer|donate|publish|post|reply|sign ?up|register|apply now|apply for|authori[sz]e|approve|deactivate|close account|place)\b/i;
  const COOKIES = /cookie|consent|gdpr/i;
  const inCookieBanner = !!el.closest('[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i]');
  const words = !realLink && COMMIT.test(name) && !COOKIES.test(name) && !inCookieBanner;
  // a GET form (search, filters) only puts the query in the address; it commits when it carries personal details
  const method = (form?.getAttribute('method') || 'get').toLowerCase();
  const personal = !!form?.querySelector('input[type=email],input[type=tel],input[type=password],[autocomplete*=email],[autocomplete*=tel],[autocomplete*=address],[autocomplete^=cc-]');
  return { tag, type: t, role, name, form: !!form, method, personal, fields: formFields(form), submitButton, words,
           textInput: tag === 'textarea' || el.isContentEditable || (tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(t)),
           sensitive: ['input', 'textarea'].includes(tag) && sensitive(el), file: tag === 'input' && t === 'file',
           select: tag === 'select', check: ['checkbox', 'radio'].includes(t) || ['checkbox', 'radio', 'switch', 'menuitemcheckbox'].includes(el.getAttribute('role') || '') };
}"""

FLASH_JS = "(el) => { const o = el.style.outline, f = el.style.outlineOffset; el.style.outline = '3px solid #f59e0b'; el.style.outlineOffset = '2px'; setTimeout(() => { el.style.outline = o; el.style.outlineOffset = f; }, 900); }"


class Browser:
    """Shell:B's own browser window, driven through Playwright. Every action comes from Shell:B (the server decides
    which need the owner's approval); this class adds the last line of defence: while an unapproved click or key runs,
    a request that would send the page's form, or anything the agent typed, is blocked and reported instead."""

    def __init__(self, headless=False):
        self.headless = headless
        self.pw = self.ctx = self.page = None
        self.filled: list[tuple[str, str, bool]] = []  # (field, value, sensitive) typed by the agent since the last approved submit
        self.blocked = None
        self.dialogs: list[str] = []
        self.acting = False
        self.profile = Path.home() / ".shellb-browser"

    # lifecycle
    def alive(self):
        return self.ctx is not None

    def ensure(self):
        if self.ctx:
            try:
                self.ctx.pages  # noqa: B018 — raises once the browser has gone
                if self.page and not self.page.is_closed():
                    return
                self.page = self.ctx.pages[-1] if self.ctx.pages else self.ctx.new_page()
                return
            except Exception:
                self.ctx = None
        if not self.pw:
            self.pw = sync_playwright().start()
        self.profile.mkdir(exist_ok=True)
        last = None
        for channel in ("chrome", "msedge", None):
            try:
                self.ctx = self.pw.chromium.launch_persistent_context(
                    str(self.profile), channel=channel, headless=self.headless, no_viewport=not self.headless,
                    accept_downloads=False, args=[] if self.headless else ["--start-maximized"])
                break
            except Exception as e:
                last = e
        if not self.ctx:
            raise RuntimeError(f"Couldn't start a browser ({last}). Install Chrome, or run: python -m playwright install chromium")
        self.ctx.add_init_script(BADGE_JS)
        self.ctx.on("page", self._new_page)
        self.ctx.on("close", lambda *_: self._closed())
        for p in self.ctx.pages:
            self._watch(p)
        self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()
        say("Opened Shell:B's browser window.")

    def _closed(self):
        self.ctx = self.page = None
        say("Shell:B's browser window was closed.")

    def _watch(self, p):
        p.on("dialog", self._dialog)

    def _new_page(self, p):
        self._watch(p)
        self.page = p  # a link or script opened a new tab: that's where things continue

    def _dialog(self, d):
        msg = f"{d.type}: {d.message[:300]}"
        if self.acting:
            self.dialogs.append(msg)
        try:
            # a confirm() during an unapproved step ("Delete this?") is declined; Shell:B is told and can ask
            d.accept() if d.type in ("alert", "beforeunload") else d.dismiss()
        except Exception:
            pass

    def pump(self):
        """Let Playwright handle events (new tabs, dialogs, a closed window) between requests."""
        if self.ctx:
            try:
                (self.page or self.ctx.pages[0]).wait_for_timeout(20)
            except Exception:
                pass

    def close(self):
        try:
            if self.ctx:
                self.ctx.close()
        except Exception:
            pass
        try:
            if self.pw:
                self.pw.stop()
        except Exception:
            pass

    # page helpers
    def frames(self):
        return [f for f in self.page.frames if not f.is_detached()]

    def loc(self, ref):
        ref = str(ref).strip().strip("[]")
        m = re.fullmatch(r"(?:f(\d+)\.)?(\d+)", ref)
        if not m:
            raise ValueError(f"{ref!r} isn't an element ref; use a number from the last read, like 12 or f1.12")
        frames = self.frames()
        fi = int(m.group(1) or 0)
        if fi >= len(frames):
            raise ValueError(f"Frame {fi} isn't on the page any more; read the page again.")
        loc = frames[fi].locator(f'[data-sb="{m.group(2)}"]')
        if loc.count() == 0:
            raise ValueError(f"Element [{ref}] isn't on the page any more; read the page again.")
        return loc.first

    def settle(self, quiet_ms=1500):
        try:
            self.page.wait_for_load_state("domcontentloaded", timeout=15000)
        except Exception:
            pass
        try:
            self.page.wait_for_load_state("networkidle", timeout=quiet_ms)
        except Exception:
            pass

    def read(self, max_chars=12000):
        out = []
        frames = self.frames()
        left = max_chars
        cut = False
        head = None
        for i, f in enumerate(frames):
            if left < 500:
                cut = True
                break
            try:
                r = f.evaluate(READ_JS, {"max": left, "prefix": "" if i == 0 else f"f{i}."})
            except Exception:
                continue
            if i == 0:
                head = r
            elif not r["lines"]:
                continue
            else:
                out.append(f"--- frame f{i}: {r['url'][:100]} ---")
            out += r["lines"]
            left -= sum(len(s) + 1 for s in r["lines"])
            cut = cut or r["cut"]
        title, url = (head or {}).get("title", ""), (head or {}).get("url", self.page.url)
        tabs = len(self.ctx.pages)
        text = "\n".join(out) + ("\n…(page cut off here; the rest isn't shown)" if cut else "")
        return {"url": url, "title": title, "tabs": tabs, "text": text}

    def shown_fields(self):
        """What the agent typed, for the approval card: passwords and card numbers masked."""
        return [[n, ("\u2022\u2022\u2022\u2022" + (v[-4:] if len(v) > 8 and v.replace(" ", "").isdigit() else "")) if sens else v]
                for n, v, sens in self.filled]

    # actions
    def do(self, r):
        self.ensure()
        self.dialogs = []
        a = r.get("action")
        fn = getattr(self, "a_" + str(a), None)
        if not fn:
            raise ValueError(f"Unknown browser action {a!r}")
        self.acting = True
        try:
            out = fn(r)
        finally:
            self.acting = False
        if self.dialogs:
            out["dialogs"] = self.dialogs
        return out

    def page_state(self, extra=None, read=True):
        out = {"url": self.page.url, "title": self.page.title(), "tabs": len(self.ctx.pages)}
        if read:
            out.update(self.read(int(extra or 8000)))
        return out

    def a_read(self, r):
        return self.read(int(r.get("max") or 12000))

    def a_open(self, r):
        url = str(r.get("url") or "").strip()
        if not re.match(r"^https?://", url, re.I):
            if re.match(r"^[\w.-]+\.[a-z]{2,}(/|$)", url, re.I):
                url = "https://" + url
            else:
                raise ValueError("Only http(s) web addresses can be opened.")
        if r.get("newTab"):
            self.page = self.ctx.new_page()
        self.page.bring_to_front()
        self.page.goto(url, wait_until="domcontentloaded", timeout=45000)
        self.filled = []
        self.settle()
        say(f"Shell:B opened {url[:100]}")
        return self.page_state()

    def a_back(self, r):
        self.page.go_back(wait_until="domcontentloaded", timeout=30000)
        self.settle()
        return self.page_state()

    def a_tabs(self, r):
        pages = self.ctx.pages
        if r.get("tab") is not None:
            i = int(r["tab"])
            if not 0 <= i < len(pages):
                raise ValueError(f"There are {len(pages)} tabs (0-{len(pages) - 1}).")
            self.page = pages[i]
            self.page.bring_to_front()
            return self.page_state()
        return {"text": "\n".join(f"{i}{' (current)' if p == self.page else ''}: {p.title()[:80]} — {p.url[:120]}" for i, p in enumerate(pages)),
                "url": self.page.url, "title": self.page.title(), "tabs": len(pages)}

    def a_scroll(self, r):
        d = str(r.get("direction") or "down")
        if r.get("ref"):
            self.loc(r["ref"]).scroll_into_view_if_needed(timeout=5000)
        else:
            self.page.mouse.wheel(0, {"down": 800, "up": -800}.get(d, 800))
        self.page.wait_for_timeout(400)
        return self.page_state(read=False)

    def a_wait(self, r):
        secs = max(0.5, min(float(r.get("seconds") or 2), 15))
        text = str(r.get("text") or "")
        if text:
            try:
                self.page.get_by_text(text).first.wait_for(timeout=secs * 1000)
            except Exception:
                pass
        else:
            self.page.wait_for_timeout(secs * 1000)
        return self.page_state()

    def a_screenshot(self, r):
        jpg = self.page.screenshot(type="jpeg", quality=80, timeout=15000)
        return {**self.page_state(read=False), "image": base64.b64encode(jpg).decode()}

    def a_describe(self, r):
        if r.get("ref"):
            loc = self.loc(r["ref"])
            d = loc.evaluate(DESCRIBE_JS)
        elif r.get("text"):
            loc = self._by_text(r["text"])
            d = loc.evaluate(DESCRIBE_JS)
        else:  # a key press on whatever has focus
            try:
                d = self.page.evaluate("() => document.activeElement && document.activeElement !== document.body")
                d = self.page.locator(":focus").first.evaluate(DESCRIBE_JS) if d else {"name": "", "form": False, "fields": []}
            except Exception:
                d = {"name": "", "form": False, "fields": []}
        if not d.get("fields"):
            d["fields"] = self.shown_fields()
        d["url"] = self.page.url
        return d

    def _by_text(self, text):
        loc = self.page.get_by_role("button", name=text)
        if loc.count() == 0:
            loc = self.page.get_by_role("link", name=text)
        if loc.count() == 0:
            loc = self.page.get_by_text(text)
        if loc.count() == 0:
            raise ValueError(f"Nothing on the page says {text!r}; read the page and use a ref.")
        return loc.first

    def _guarded(self, fn, approved):
        """Run one click or key. Unless the owner approved it, block what would send typed data or a form."""
        self.blocked = None
        if approved:
            fn()
            self.filled = []
            return
        typed = {v for _, v, _s in self.filled if len(v) >= 3}
        forms = set()
        for v in typed:
            forms |= {v, urllib.parse.quote_plus(v), urllib.parse.quote(v), json.dumps(v)[1:-1]}

        def guard(route, request):
            try:
                if request.method not in ("GET", "HEAD", "OPTIONS"):
                    body = request.post_data or ""
                    if request.resource_type == "document" or any(f and f in body for f in forms):
                        self.blocked = {"method": request.method, "url": request.url[:300], "kind": request.resource_type}
                        return route.abort("aborted")  # "aborted" keeps the page as it was; other codes show an error page
            except Exception:
                pass
            route.fallback()

        self.ctx.route("**/*", guard)
        try:
            fn()
            self.settle(1500)
        finally:
            try:
                self.ctx.unroute("**/*", guard)
            except Exception:
                pass

    def a_click(self, r):
        loc = self.loc(r["ref"]) if r.get("ref") else self._by_text(str(r.get("text") or ""))
        if loc.evaluate("el => el.tagName") == "SELECT":  # a native dropdown opens outside the page; choosing is fill's job
            opts = loc.evaluate("el => [...el.options].map(o => o.text.trim()).filter(Boolean)")
            raise ValueError("That's a dropdown: choose with fill, e.g. fields=[{ref, value: '<option>'}]. Options: " + " | ".join(opts[:30]))
        name = loc.evaluate("el => (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.value || '').trim().split('\\n')[0].slice(0, 60)")
        loc.scroll_into_view_if_needed(timeout=5000)
        loc.evaluate(FLASH_JS)

        def click():
            try:
                loc.click(timeout=8000)
            except Exception:
                loc.click(timeout=4000, force=True)
        self._guarded(click, bool(r.get("approved")))
        if self.blocked:
            say(f"Held back a submit from {name!r} until you approve it in the chat")
            return {**self.page_state(read=False), "blocked": self.blocked, "fields": self.shown_fields()}
        self.settle()
        say(f"Shell:B clicked {name!r}" + (" (approved)" if r.get("approved") else ""))
        return self.page_state()

    def a_press(self, r):
        key = str(r.get("key") or "Enter")
        if r.get("ref"):
            self.loc(r["ref"]).focus(timeout=5000)
        self._guarded(lambda: self.page.keyboard.press(key), bool(r.get("approved")))
        if self.blocked:
            say(f"Held back a submit from pressing {key} until you approve it in the chat")
            return {**self.page_state(read=False), "blocked": self.blocked, "fields": self.shown_fields()}
        self.settle()
        return self.page_state()

    def a_fill(self, r):
        done, problems = [], []
        for item in r.get("fields") or []:
            ref, value = item.get("ref"), item.get("value")
            try:
                loc = self.loc(ref)
                d = loc.evaluate(DESCRIBE_JS)
                label = d.get("name") or f"[{ref}]"
                if d.get("sensitive") and not item.get("userGiven"):
                    problems.append(f"[{ref}] {label}: not filled. It's a password/card/ID field, and that value isn't one "
                                    "the user typed in this chat. Ask them to type it into the window themselves.")
                    continue
                if d.get("file"):
                    problems.append(f"[{ref}] {label}: file uploads aren't supported; ask the user to pick the file in the window.")
                    continue
                loc.scroll_into_view_if_needed(timeout=5000)
                loc.evaluate(FLASH_JS)
                if d.get("select"):
                    v = str(value)
                    try:
                        loc.select_option(label=v, timeout=4000)
                    except Exception:
                        try:
                            loc.select_option(value=v, timeout=4000)
                        except Exception:
                            opts = loc.evaluate("el => [...el.options].map(o => o.text.trim())")
                            raise ValueError(f"no option {v!r}; options are: {' | '.join(opts[:40])}")
                    now = loc.evaluate("el => [...el.selectedOptions].map(o => o.text.trim()).join(', ')")
                elif d.get("check"):
                    want = value if isinstance(value, bool) else str(value).strip().lower() not in ("false", "0", "no", "off", "unchecked", "")
                    try:
                        loc.set_checked(want, timeout=4000)
                    except Exception:
                        try:
                            loc.set_checked(want, timeout=3000, force=True)
                        except Exception:
                            loc.evaluate("(el, want) => { if (el.checked !== want) el.click(); }", want)
                    now = "checked" if loc.evaluate("el => el.checked ?? el.getAttribute('aria-checked') === 'true'") else "unchecked"
                else:
                    v = "" if value is None else str(value)
                    try:
                        loc.fill(v, timeout=5000)
                    except Exception:  # custom widgets (masked inputs, date pickers): type it like a person
                        loc.click(timeout=4000)
                        self.page.keyboard.press("ControlOrMeta+A")
                        self.page.keyboard.type(v, delay=15)
                    now = loc.evaluate("el => el.isContentEditable && el.tagName !== 'INPUT' ? el.innerText : el.value")
                    if v:
                        self.filled.append((label, v, bool(d.get("sensitive"))))
                    if d.get("sensitive"):
                        now = "••••"
                done.append(f"[{ref}] {label} = {json.dumps(now)[:200]}")
            except Exception as e:
                problems.append(f"[{ref}]: {str(e).splitlines()[0][:300]}")
        if done:
            say(f"Shell:B filled {len(done)} field(s)")
        self.page.wait_for_timeout(400)
        summary = "\n".join(["Filled:"] + done if done else []) + ("\n\nProblems:\n" + "\n".join(problems) if problems else "")
        page = self.read(6000)  # the page as it is now: suggestions, validation messages, fields that appeared
        return {**page, "text": summary + "\n\nThe page now:\n" + page["text"]}


# ── main loop ───────────────────────────────────────────────────────────────

def poller(c, hello, out: queue.Queue, stop: threading.Event, state: dict):
    """Keeps the connection: registers with Shell:B and long-polls for requests, handing them to the main thread."""
    backoff = 2
    while not stop.is_set():
        try:
            if not state.get("sid"):
                state["sid"] = c.call("POST", "/api/screen/connect", hello)["id"]
                abilities = " and ".join(x for x in ("look at this screen" if hello["monitors"] else "",
                                                     "use a browser window" if hello["browser"] else "") if x)
                print(f"Connected to {c.url} as {hello['name']!r}. Shell:B can {abilities} until you stop this (Ctrl+C).", flush=True)
                backoff = 2
            r = c.call("GET", f"/api/screen/next?id={state['sid']}", timeout=60)["request"]
            if r:
                out.put((state["sid"], r))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                out.put((None, {"fatal": "Shell:B doesn't recognise this helper any more (it was unpaired). Pair it again in Settings → Screen."}))
                return
            if e.code == 404:  # Shell:B restarted and forgot this source: connect again
                state["sid"] = None
                continue
            print(f"Shell:B answered {e.code}; retrying in {backoff} s", flush=True)
            stop.wait(backoff)
            backoff = min(backoff * 2, 60)
        except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
            print(f"Can't reach Shell:B ({getattr(e, 'reason', e)}); retrying in {backoff} s", flush=True)
            state["sid"] = None
            stop.wait(backoff)
            backoff = min(backoff * 2, 60)


def handle(c, sid, r, sct, browser):
    rid = r["rid"]
    if r.get("kind") == "browser":
        try:
            if not browser:
                raise RuntimeError("Browser use is off in this helper (install playwright, and don't pass --no-browser).")
            res = {"ok": True, **browser.do(r)}
        except Exception as e:
            res = {"ok": False, "error": str(e).splitlines()[0][:500] if str(e) else type(e).__name__}
            say(f"browser {r.get('action')} failed: {res['error'][:120]}")
        c.call("POST", f"/api/screen/result/{rid}?id={sid}", body=res, timeout=60)
        return
    try:
        if not sct:
            raise RuntimeError("Screen capture is off in this helper (pip install mss pillow).")
        data, ctype, n, size = grab(sct, r.get("monitor"), int(r.get("maxEdge") or 2560))
        c.call("POST", f"/api/screen/frame/{rid}?id={sid}", data=data, ctype=ctype, timeout=60)
        say(f"Shell:B looked at your screen ({'all monitors' if n == 0 else f'monitor {n}'}, {size[0]}x{size[1]})")
    except Exception as e:
        say(f"capture failed: {e}")
        c.call("POST", f"/api/screen/frame/{rid}?id={sid}", data=b"", headers={"x-screen-error": f"capture failed: {e}"[:200]})


def main():
    ap = argparse.ArgumentParser(description="Let Shell:B look at this screen and use a browser window when an agent asks.")
    ap.add_argument("--url", default=DEFAULT_URL, help="Shell:B's HTTPS address")
    ap.add_argument("--token", default=DEFAULT_TOKEN, help="device token from Settings → Screen")
    ap.add_argument("--name", default=DEFAULT_NAME or socket.gethostname(), help="name shown in Shell:B")
    ap.add_argument("--no-screen", action="store_true", help="don't let Shell:B take screenshots")
    ap.add_argument("--no-browser", action="store_true", help="don't let Shell:B use a browser window")
    ap.add_argument("--headless", action="store_true", help=argparse.SUPPRESS)  # tests: an invisible browser
    a = ap.parse_args()
    if not a.url or not a.token:
        die("Give --url and --token, or download a paired copy from Shell:B: Settings → Screen → Pair a computer.")
    if not a.url.startswith("https://") and "://localhost" not in a.url and "://127.0.0.1" not in a.url:
        die("Use Shell:B's HTTPS address: screenshots and pages shouldn't cross the network unencrypted.")
    use_screen = bool(mss) and not a.no_screen
    use_browser = bool(sync_playwright) and not a.no_browser
    if not use_screen and not use_browser:
        die("Nothing to share: install mss (screen) and/or playwright (browser):  pip install mss pillow playwright")
    if not mss and not a.no_screen:
        print("(Screen capture is off: pip install mss pillow)", flush=True)
    if not sync_playwright and not a.no_browser:
        print("(Browser use is off: pip install playwright)", flush=True)
    c = Client(a.url, a.token)
    sct = mss.mss() if use_screen else None
    browser = Browser(headless=a.headless) if use_browser else None
    hello = {"name": a.name, "label": f"{platform.system()} desktop", "monitors": monitors(sct) if sct else [],
             "screen": use_screen, "browser": use_browser}
    jobs: queue.Queue = queue.Queue()
    stop = threading.Event()
    state: dict = {}
    threading.Thread(target=poller, args=(c, hello, jobs, stop, state), daemon=True).start()
    try:
        while True:
            try:
                sid, r = jobs.get(timeout=0.25)
            except queue.Empty:
                if browser:
                    browser.pump()
                continue
            if r.get("fatal"):
                die(r["fatal"])
            try:
                handle(c, sid, r, sct, browser)
            except Exception as e:  # the answer couldn't be delivered (Shell:B restarted, network): it will time out there
                say(f"couldn't send the result: {e}")
    finally:
        stop.set()
        if state.get("sid"):
            try:
                c.call("POST", f"/api/screen/disconnect?id={state['sid']}", data=b"", timeout=5)
            except Exception:
                pass
        if browser:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped. Shell:B can no longer see this screen or use the browser window.")
