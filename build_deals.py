#!/usr/bin/env python3
"""TDP Daily Deals — finds the best entertainment deals and vouchers (music, cinema, theatre & musicals, comedy)
from reliable UK sources and writes deals.json for the website.

    python3 build_deals.py                 # writes deals.json
    python3 build_deals.py --search wicked # prints what a live search would find (same as the apps' search box)

Sources (see rules.json → "sources"):
  olt       Official London Theatre special offers (Society of London Theatre)
  todaytix  TodayTix London: discounts, Rush, Lottery and no-fee promotions
  hukd      HotUKDeals: community-voted deals and vouchers, active deals only (tag pages + searches)
  news      Google News (UK edition): deal headlines from established publishers

This is the reference implementation. The Mac app (Swift) and the Windows app (C#) port these exact rules and read
the same rules.json, so any change here must be mirrored there.
"""
import concurrent.futures as cf
import datetime as dt
import html
import json
import math
import re
import sys
import threading
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
RULES = json.loads((HERE / "rules.json").read_text(encoding="utf-8"))
NOW = dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------- text matching (identical in every port)

def norm(s):
    """Lowercase, strip accents, '&' → 'and', every run of non [a-z0-9£%] → one space, padded with spaces."""
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c)).replace("&", " and ")
    s = re.sub(r"[^a-z0-9£%]+", " ", s).strip()
    return f" {s} "


def hits(text_norm, words):
    """How many of `words` appear in the normalised text as whole words/phrases."""
    return sum(1 for w in words if norm(w) in text_norm)


def classify(text, hint=None):
    """Best category id for a text, or None. A hint (from the tag/search/source) counts as 2 keyword hits."""
    t = norm(text)
    best, best_score = None, 0
    for cat in RULES["categories"]:
        cid = cat["id"]
        score = hits(t, RULES["keywords"][cid]) + (2 if hint == cid else 0)
        if score > best_score:
            best, best_score = cid, score
    return best


def is_ticket(text):
    return hits(norm(text), RULES["ticketWords"]) > 0


def is_product(text):
    return hits(norm(text), RULES["productWords"]) > 0


def keep_entertainment(text, strict):
    """Strict sources (broad tags, searches) need a ticket word; every source drops products without one."""
    ticket = is_ticket(text)
    if is_product(text) and not ticket:
        return False
    return ticket or not strict


# ---------------------------------------------------------------- helpers

def fetch(url, accept="text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"):
    req = urllib.request.Request(url, headers={"User-Agent": RULES["userAgent"], "Accept": accept,
                                               "Accept-Language": "en-GB,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode("utf-8", "replace")


def iso(ts):
    return ts.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if ts else None


def from_unix(n):
    return dt.datetime.fromtimestamp(n, dt.timezone.utc) if n else None


def money(v):
    """£8 / £9.50"""
    if v is None:
        return None
    return f"£{v:.0f}" if abs(v - round(v)) < 0.005 else f"£{v:.2f}"


PCT_RE = re.compile(r"(\d{1,2})\s*%\s*off", re.I)
POUND_RE = re.compile(r"£\s*(\d+(?:\.\d{1,2})?)")


def title_discount(title):
    m = PCT_RE.search(title)
    if m:
        return int(m.group(1))
    if re.search(r"\b(2\s*for\s*1|2-for-1|two for one|bogof|half price)\b", title, re.I):
        return 50
    return None


def is_free(title, price):
    return bool(re.search(r"\bfree\b", title, re.I)) and not price


def deal(**kw):
    base = dict(id="", source="", title="", subtitle="", category=None, kind="deal", badges=[], merchant="", url="",
                image="", price=None, priceText="", discount=None, code="", heat=None, rating=None, published=None,
                expires=None, venue="", score=0)
    base.update(kw)
    return base


# ---------------------------------------------------------------- HotUKDeals

VUE_RE = re.compile(r"""data-vue3=(?:'([^']*)'|"([^"]*)")""")


def hukd_threads(page_html):
    """Threads embedded in a HotUKDeals listing page (tag page or search) as JSON in data-vue3 attributes."""
    out = []
    for a, b in VUE_RE.findall(page_html):
        try:
            j = json.loads(html.unescape(a or b))
        except ValueError:
            continue
        if j.get("name") == "ThreadMainListItemNormalizer":
            t = (j.get("props") or {}).get("thread")
            if t:
                out.append(t)
    return out


def hukd_deal(t, hint, strict):
    """One HotUKDeals thread → deal dict, or None when it isn't an active entertainment deal."""
    h = RULES["hukd"]
    if t.get("type") == "Discussion" or t.get("isExpired") or t.get("deletedAt"):
        return None
    group = (t.get("mainGroup") or {}).get("threadGroupName") or ""
    if group in h["excludeGroups"]:
        return None
    temp = t.get("temperature") or 0
    if temp < 0:  # voted cold by the community
        return None
    end = from_unix(((t.get("endDate") or {}).get("timestamp")))
    if end and end < NOW:
        return None
    pub = from_unix(t.get("publishedAt"))
    if pub:
        age = (NOW - pub).days
        if age > (h["maxAgeDaysIfHot"] if temp >= h["hotTemperature"] else h["maxAgeDays"]):
            return None
    title = html.unescape(t.get("title") or "").strip()
    merchant = ((t.get("merchant") or {}).get("merchantName") or "").strip()
    text = f"{title} {merchant}"
    if not keep_entertainment(text, strict):
        return None
    cat = classify(text, hint)
    if not cat:
        return None
    price = t.get("price") or None
    nxt = t.get("nextBestPrice") or None
    disc = int(t.get("percentage") or 0) or None
    if not disc and price and nxt and nxt > price:
        disc = round((1 - price / nxt) * 100)
    if not disc:
        disc = title_discount(title)
    code = "" if t.get("isVoucherCodeHidden") else (t.get("voucherCode") or "").strip()
    free = is_free(title, price)
    kind = "free" if free else ("voucher" if t.get("type") == "Voucher" or code else "deal")
    slug, tid = t.get("titleSlug") or "", t.get("threadId")
    section = "vouchers" if t.get("type") == "Voucher" else "deals"
    img = t.get("mainImage") or {}
    if img.get("path") and img.get("name"):
        image = f"https://images.hotukdeals.com/{img['path']}/{img['name']}/re/768x768/qt/60/{img['name']}.jpg"
    else:
        av = (t.get("merchant") or {}).get("avatar") or {}
        image = (f"https://images.hotukdeals.com/{av['path']}/{av['name']}/re/150x150/qt/60/{av['name']}.jpg"
                 if av.get("path") and av.get("name") else "")
    badges = [f"{round(temp)}°"]
    if disc:
        badges.append(f"{disc}% off")
    if code:
        badges.append(f"Code {code}")
    if free:
        badges.append("FREE")
    return deal(id=f"hukd-{tid}", source="hukd", title=title, subtitle=merchant, category=cat, kind=kind,
                badges=badges, merchant=merchant, url=f"{h['base']}/{section}/{slug}-{tid}", image=image,
                price=price, priceText="FREE" if free else (money(price) or ""), discount=disc, code=code,
                heat=round(temp, 1), published=iso(pub), expires=iso(end))


def hukd_pages():
    h = RULES["hukd"]
    pages = [(f"{h['base']}/tag/{x['tag']}", x["category"], x["strict"]) for x in h["tags"]]
    pages += [(f"{h['base']}/search?q={urllib.parse.quote_plus(x['q'])}", x["category"], x["strict"]) for x in h["searches"]]
    return pages


HUKD_GATE = threading.Semaphore(3)  # be gentle: at most 3 HotUKDeals requests at a time


def hukd_page(url, hint, strict):
    with HUKD_GATE:
        page = fetch(url)
    return [d for d in (hukd_deal(t, hint, strict) for t in hukd_threads(page)) if d]


def hukd_search(query):
    """Live search (desktop apps' search box): a HotUKDeals search, keeping entertainment deals only."""
    url = f"{RULES['hukd']['base']}/search?q={urllib.parse.quote_plus(query)}"
    return hukd_page(url, None, True)


# ---------------------------------------------------------------- Official London Theatre

ART_RE = re.compile(r'<article class="shows-grid-item"(.*?)</article>', re.S)
ATTR_RE = re.compile(r'(data-[a-z-]+)="([^"]*)"')


def olt_deals():
    o = RULES["olt"]
    page = fetch(o["url"])
    out = []
    for block in ART_RE.findall(page):
        head = block.split(">", 1)[0]
        a = {k: html.unescape(v) for k, v in ATTR_RE.findall(head)}
        name = a.get("data-name", "").strip()
        href = re.search(r'href="([^"]+)"', block)
        if not name or not href:
            continue
        img = re.search(r'<img[^>]+src="([^"]+)"', block)
        genres = [g.strip() for g in a.get("data-genres", "").split(",") if g.strip()]
        mapped = {o["genreMap"][g] for g in genres if g in o["genreMap"]}
        cat = next((c for c in o["priority"] if c in mapped), "theatre")
        disc = int(float(a.get("data-discount") or 0)) or None
        low = float(a["data-min-price"]) if a.get("data-min-price") else None
        end = None
        if a.get("data-offer-end"):
            end = dt.datetime.strptime(a["data-offer-end"], "%Y-%m-%d").replace(hour=23, minute=59, tzinfo=dt.timezone.utc)
            if end < NOW:
                continue
        badges = [f"Save up to {disc}%"] if disc else ["Special offer"]
        if "Show of the Week" in block:
            badges.insert(0, "Show of the Week")
        if low:
            badges.append(f"From {money(low)}")
        slug = re.sub(r"[^a-z0-9]+", "-", href.group(1).rstrip("/").rsplit("/", 1)[-1].lower()).strip("-")
        out.append(deal(id=f"olt-{slug}", source="olt",
                        title=name, subtitle=", ".join(genres), category=cat, kind="offer", badges=badges,
                        merchant="Official London Theatre", url=href.group(1), image=img.group(1) if img else "",
                        price=low, priceText=f"from {money(low)}" if low else "", discount=disc, expires=iso(end),
                        venue="London"))
    return out


# ---------------------------------------------------------------- TodayTix

def todaytix_deals():
    t = RULES["todaytix"]
    out = []
    for loc in t["locations"]:
        data = json.loads(fetch(t["api"].format(id=loc["id"]), accept="application/json")).get("data") or []
        for s in data:
            cat = t["categoryMap"].get((s.get("category") or {}).get("name"))
            if not cat:
                continue
            badges, kind = [], None
            disc = int(s.get("maxDiscountPercentage") or 0) or None
            if disc:
                badges.append(f"Save {disc}%")
                kind = "offer"
            lottery_price = None
            if s.get("isLotteryActive"):
                txt = s.get("lotteryBannerText") or "Lottery tickets"
                badges.append(txt)
                m = POUND_RE.search(txt)
                lottery_price = float(m.group(1)) if m else None
                kind = kind or "lottery"
            rush_price = None
            if s.get("isRushActive"):
                txt = s.get("rushBannerText") or "Rush tickets"
                badges.append(txt)
                m = POUND_RE.search(txt)
                rush_price = float(m.group(1)) if m else None
                kind = kind or "rush"
            promo = (s.get("promotion") or {}).get("label")
            if promo in t["promoLabels"]:
                badges.append(promo)
                kind = kind or "offer"
            if not kind:
                continue
            reg = (s.get("lowPriceForRegularTickets") or {}).get("value")
            price = {"lottery": lottery_price, "rush": rush_price}.get(kind) or reg
            name = (s.get("displayName") or s.get("name") or "").strip()
            img = s.get("posterImageSquareUrl") or s.get("posterImageUrl") or ""
            end = s.get("endDate")
            end_ts = None
            if end and end != "null":
                try:
                    end_ts = dt.datetime.strptime(end[:10], "%Y-%m-%d").replace(hour=23, minute=59, tzinfo=dt.timezone.utc)
                except ValueError:
                    pass
            out.append(deal(id=f"todaytix-{s.get('id')}", source="todaytix", title=name,
                            subtitle=s.get("venue") or loc["name"], category=cat, kind=kind, badges=badges, merchant="TodayTix",
                            url=t["showUrl"].format(seo=loc["seo"], id=s.get("id"), slug=s.get("slug") or ""),
                            image=(img + "?w=400&h=400&fit=fill") if img else "", price=price,
                            priceText=f"from {money(price)}" if price else "", discount=disc,
                            rating=round(s["avgRating"], 2) if s.get("avgRating") else None, expires=iso(end_ts),
                            venue=f"{s.get('venue') or ''}, {loc['name']}".strip(", ")))
    return out


# ---------------------------------------------------------------- News

def news_items(query, hint, max_days):
    n = RULES["news"]
    xml = fetch(n["rss"].format(q=urllib.parse.quote_plus(query)), accept="application/rss+xml,application/xml")
    root = ET.fromstring(xml)
    publishers = {norm(p) for p in n["publishers"]}
    out = []
    for it in root.iter("item"):
        src = (it.findtext("source") or "").strip()
        if norm(src) not in publishers:
            continue
        title = html.unescape(it.findtext("title") or "").strip()
        if src and title.endswith(f" - {src}"):
            title = title[: -len(src) - 3].strip()
        t = norm(title)
        if hits(t, n["excludeWords"]) or any(c in title for c in n["excludeSymbols"]):
            continue
        if not (hits(t, n["dealWords"]) or "£" in title):
            continue
        cat = classify(title, hint)
        if not cat:
            continue
        try:
            pub = dt.datetime.strptime(it.findtext("pubDate") or "", "%a, %d %b %Y %H:%M:%S %Z").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            pub = None
        if pub and (NOW - pub).days > max_days:
            continue
        link = it.findtext("link") or ""
        out.append(deal(id="news-" + re.sub(r"[^a-z0-9]+", "-", t.strip())[:80], source="news", title=title,
                        subtitle=src, category=cat, kind="news", badges=[src], merchant=src, url=link,
                        discount=title_discount(title), published=iso(pub)))
    return out


def news_deals():
    out = []
    for q in RULES["news"]["queries"]:
        out += news_items(q["q"], q["category"], 14)
    return out


def news_search(query):
    return news_items(RULES["news"]["searchQuery"].format(query=query), None, 30)


# ---------------------------------------------------------------- scoring

def score(d):
    tr = RULES["trust"].get(d["source"], 0.5)
    if d["kind"] == "free":
        value = 1.0
    elif d["discount"]:
        value = min(1.0, d["discount"] / 60)
    elif d["kind"] == "lottery":
        value = 0.8
    elif d["kind"] == "rush":
        value = 0.65
    elif d["price"] and d["price"] <= 10:
        value = 0.7
    elif d["kind"] in ("voucher", "offer"):
        value = 0.5
    elif d["kind"] == "news":
        value = 0.35
    else:
        value = 0.4
    if d["source"] == "hukd":
        t = d["heat"] or 0
        heat = 0.0 if t <= 1 else min(1.0, math.log10(t) / math.log10(2000))
    elif d["source"] == "todaytix":
        heat = 0.4 + (d["rating"] or 3.5) / 5 * 0.4
    elif d["source"] == "olt":
        heat = 0.75
    else:
        heat = 0.4
    if d["published"]:
        age = (NOW - dt.datetime.strptime(d["published"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)).days
        fresh = max(0.0, 1 - age / 60)
    else:
        fresh = 0.8
    w = RULES["weights"]
    return round(100 * (w["trust"] * tr + w["value"] * value + w["heat"] * heat + w["fresh"] * fresh))


def finish(deals):
    """Dedupe by id (first wins), score and sort best-first."""
    seen, out = set(), []
    for d in deals:
        if d["id"] in seen:
            continue
        seen.add(d["id"])
        d["score"] = score(d)
        out.append(d)
    out.sort(key=lambda d: (-d["score"], d["title"]))
    return out


# ---------------------------------------------------------------- main

def run_jobs(jobs):
    """jobs: list of (source id, label, callable). Runs them in parallel; results are combined in JOB order
    (not completion order) so that when the same deal turns up on two pages, the first page in the list always wins.
    Returns (deals, per-source status)."""
    deals, status = [], {}
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        futs = [(ex.submit(fn), sid, label) for sid, label, fn in jobs]
        for f, sid, label in futs:
            st = status.setdefault(sid, {"ok": 0, "failed": 0, "errors": []})
            try:
                deals += f.result()
                st["ok"] += 1
            except Exception as e:  # one broken page must not stop the rest
                st["failed"] += 1
                st["errors"].append(f"{label}: {e}")
    return deals, status


def build():
    jobs = [("olt", "offers", olt_deals), ("todaytix", "shows", todaytix_deals), ("news", "headlines", news_deals)]
    for url, hint, strict in hukd_pages():
        jobs.append(("hukd", url.rsplit("/", 1)[-1], lambda u=url, h=hint, s=strict: hukd_page(u, h, s)))
    deals, status = run_jobs(jobs)
    deals = finish(deals)
    sources = []
    for s in RULES["sources"]:
        st = status.get(s["id"], {"ok": 0, "failed": 1, "errors": ["not run"]})
        sources.append({**s, "ok": st["ok"] > 0, "count": sum(1 for d in deals if d["source"] == s["id"]),
                        "errors": st["errors"][:5]})
    return {"version": 1, "generatedAt": iso(NOW), "sources": sources,
            "categories": RULES["categories"], "deals": deals}


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--search":
        q = " ".join(sys.argv[2:])
        deals, status = run_jobs([("hukd", "search", lambda: hukd_search(q)), ("news", "search", lambda: news_search(q))])
        for d in finish(deals):
            print(f"{d['score']:3} {d['source']:8} {d['category']:8} {d['kind']:8} {d['title'][:90]}")
        print(status)
        return
    data = build()
    total = len(data["deals"])
    ok_sources = [s for s in data["sources"] if s["ok"]]
    for s in data["sources"]:
        print(f"{s['name']:24} {'ok' if s['ok'] else 'FAILED':6} {s['count']:4} deals  {'; '.join(s['errors'])[:200]}")
    if total == 0 or not ok_sources:
        # Keep the last good file rather than publishing an empty site.
        print("No deals found — keeping the previous deals.json")
        sys.exit(1)
    (HERE / "deals.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote deals.json with {total} deals")


if __name__ == "__main__":
    main()
