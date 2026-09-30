# TDP Daily Deals — product spec (shared by the website, the Mac app and the Windows app)

TDP Daily Deals finds the best **UK** deals, discounts and vouchers for entertainment and live events —
**music & gigs, cinema, theatre & musicals, shows & events** — from reliable sources, ranks them with a
"deal score", and has an **I'm Feeling Lucky** button that spins through the best deals and lands on one.

Three front-ends, one set of rules:

| Front-end | Where | How it gets deals |
|---|---|---|
| Website | `tdp-daily-deals/` → GitHub `mircix/tdp-daily-deals` → https://mircix.github.io/tdp-daily-deals/ | `deals.json`, rebuilt by a GitHub Action every 3 h with `build_deals.py` |
| Mac app | `TDPDailyDeals/` (SwiftPM/SwiftUI) | live from the sources (Swift port of `build_deals.py`) |
| Windows app | `TDPDailyDeals-Windows/` (WPF .NET 8) | live from the sources (C# port of `build_deals.py`) |

## Single source of truth

* **`rules.json`** — keywords, source lists, trust, scoring weights, lucky settings. All three read it.
  Desktop apps bundle a copy **and** download `https://mircix.github.io/tdp-daily-deals/rules.json` on each refresh
  (8 s timeout; cache the last good copy; fall back to the bundled one). Unknown extra keys must be ignored.
* **`build_deals.py`** — the reference implementation of every parsing/filtering/scoring rule. Ports must produce
  the same deals for the same input. When in doubt, read the Python.

## Deal record (the `deals` array in deals.json; ports use the same field names in their cache files)

```
id          "hukd-4991179" | "olt-<slug>" | "todaytix-287" | "news-<slug>"
source      "hukd" | "olt" | "todaytix" | "news"
title       display title
subtitle    merchant (hukd), genres (olt), venue (todaytix), publisher (news)
category    "music" | "cinema" | "theatre" | "comedy"   (comedy is shown as "Shows & Events")
kind        "deal" | "voucher" | "free" | "offer" | "rush" | "lottery" | "news"
badges      ["2354°", "50% off", "Code ABC", "FREE", "Save up to 42%", "£25 Rush tickets", "Pay No Fees", …]
merchant, url, image, venue           strings ("" when unknown)
price       number | null (GBP)       priceText  "£8" | "from £23" | "FREE" | ""
discount    int percent | null        code       voucher code or ""
heat        HotUKDeals temperature (°) | null      rating  TodayTix avg rating (0–5) | null
published, expires                    ISO-8601 UTC strings | null
score       0–100 deal score
```

deals.json = `{ version, generatedAt, sources:[{id,name,url,about,ok,count,errors}], categories, deals }`, deals sorted best-first.

## Sources (details and exact rules in build_deals.py)

1. **Official London Theatre** `officiallondontheatre.com/offers/` — HTML; each `<article class="shows-grid-item" data-name
   data-genres data-min-price data-discount data-offer-end …>` is an offer. Category from genres with priority theatre > music > comedy.
2. **TodayTix** `api.todaytix.com/api/v2/shows?location=2&limit=300` — JSON; a show is a deal when it has a discount
   (`maxDiscountPercentage`), an active Lottery or Rush (banner texts give labels/prices), or a promo label from `rules.todaytix.promoLabels`.
3. **HotUKDeals** — HTML listing pages (tag pages + search pages from rules.hukd). Deals are embedded as JSON in
   `data-vue3='…'` attributes (HTML-entity-escaped); keep objects whose `name` is `ThreadMainListItemNormalizer`, read `props.thread`.
   Drop: Discussions, expired, deleted, excluded groups, temperature < 0, past endDate, too old, products without a ticket word,
   and (for "strict" pages) anything without a ticket word. Some tag pages answer **410 Gone** — that's why most are searches.
   Be gentle: at most 3 HotUKDeals requests at a time.
4. **News** — Google News RSS (UK edition) queries from rules.news; only publishers in `rules.news.publishers` (exact match after
   normalising), must contain a deal word or "£", must not contain exclude words or "$".

Text matching is word-based: `norm(s)` = lowercase, strip accents, `&`→` and `, every run of chars outside `[a-z0-9£%]` → one
space, then pad with a space on both sides; a keyword matches when `norm(keyword)` is a substring of `norm(text)`.

## Deal score

`score = round(100 × (0.30·trust + 0.35·value + 0.25·heat + 0.10·fresh))` (weights from rules.json):
trust per source; value from free/discount/lottery/rush/cheap price; heat from HotUKDeals temperature (log scale, 2000° = 1),
TodayTix rating, or a fixed value; fresh decays over 60 days from `published` (0.8 when unknown). See `score()`.

## Features every front-end has

* **Header**: ticket logo, "TDP Daily Deals", tagline "The best UK deals on gigs, cinema, theatre & shows",
  "Updated 5 min ago" + **Refresh**.
* **Search box** (placeholder "Search a band, film, show, cinema or venue…") with two buttons side by side:
  **Search deals** and **I'm Feeling Lucky 🍀**.
  * Local search: every query word (normalised) must appear **at the start of a word** (`hay.contains(" " + word)`, so "wick"
    finds "Wicked") in norm(title + subtitle + merchant + venue + badges + category name + source name).
  * Desktop apps also run a **live search** on Enter/Search: HotUKDeals search page for the query (strict) + Google News
    `rules.news.searchQuery` (30 days) — merged with local matches, deduped by id, sorted by score. Show a small spinner while it runs.
  * Website: local search only, plus "Search more on HotUKDeals · TodayTix · Google News" links built from the query.
* **Category chips** with counts: All · 🎸 Music & Gigs · 🎬 Cinema · 🎭 Theatre & Musicals · 🎪 Shows & Events.
* **Filters**: sort (Best deals = score, Biggest discount, Lowest price, Newest, Hottest°); toggles "Free only", "Vouchers & codes";
  source chips (Official London Theatre, TodayTix, HotUKDeals, News) to include/exclude.
* **Deal card**: image (16:9 area, cover; placeholder gradient + category emoji when missing/failed), category emoji + name,
  score badge ("87" in a ring; green ≥ 80, amber 65–79, grey below), title (2 lines max), subtitle, badges row, price text,
  source name with a small "✓ trusted source" style tag, expiry ("Ends 7 Oct") when known, buttons **Get deal ↗** (opens url in the
  browser) and **Copy code** when `code` is set.
* **I'm Feeling Lucky 🍀**: candidates = the list currently shown (after search/filters) sorted by score, top `rules.lucky.pool` (30);
  weight = score^`rules.lucky.power` (2); weighted random pick, never the same deal twice in a row when there's a choice.
  Show a full-window overlay "slot machine": the card area cycles quickly through candidate titles/images (~2.2 s, slowing down
  with ease-out), then reveals the pick with a little confetti/sparkle, its card, and buttons **Take me there ↗** and **Spin again**.
  Esc / click outside closes it.
* **Sources panel** (button "Sources" in the header): each source with ✓/✗ status, deal count, the `about` text and a link.
* **Footer**: "Prices and availability change fast — always check the final price on the seller's site. TDP Daily Deals isn't
  affiliated with any of these sites."

Desktop-only:
* Show the cached deals instantly on launch, then refresh. Auto-refresh every 60 minutes while running.
* If a source fails live, use that source's deals from the website's `deals.json`
  (`https://mircix.github.io/tdp-daily-deals/deals.json`) when it's less than 24 h old, and mark the source "via website".
* No accounts or settings needed.

## Look

Dark-first "night out" theme (light theme follows the system):

| token | dark | light |
|---|---|---|
| background | #0E0B14 | #FAF7FC |
| surface | #17121F | #FFFFFF |
| surface 2 | #211A2C | #F2EDF7 |
| border | #2E2540 | #E6DFEE |
| text | #F4F0FA | #1A1422 |
| muted | #A89CB8 | #6B6078 |
| accent gradient | #FF3D7F → #FFA23D | same |
| lucky (gold) | #FFC83D (dark text #1A1422) | same |
| music | #8B6CFF | #6E4FF0 |
| cinema | #3DB2FF | #1E8FE0 |
| theatre | #FF3D7F | #E0245E |
| shows & events | #FFB23D | #D98A00 |
| score good / ok / low | #2BD67B / #FFB23D / #8A7F99 | #13A85A / #D98A00 / #8A7F99 |

Cards: 16 px corner radius, 1 px border, subtle shadow; primary buttons use the accent gradient with white text;
the Lucky button is gold. Icon: `assets/icon/` (ticket.svg + marks.svg layers; flat PNGs in `assets/icon/png/`).
