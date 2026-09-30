# TDP Daily Deals

The best **UK deals, discounts and vouchers** for gigs, cinema, theatre & musicals and shows — gathered from trusted
sources, ranked by a deal score, with an **I'm Feeling Lucky 🍀** button.

**Live site:** https://mircix.github.io/tdp-daily-deals/

## Where the deals come from

| Source | What it gives | Why it's trusted |
|---|---|---|
| [Official London Theatre](https://officiallondontheatre.com/offers/) | West End offers ("Save up to 58%") | The Society of London Theatre's own site |
| [TodayTix](https://www.todaytix.com/london) | Discounts, £ Rush seats, Lottery tickets, no-fee offers | Major official ticket seller |
| [HotUKDeals](https://www.hotukdeals.com/tag/cinema) | Cinema, theatre, gig & event deals and voucher codes | Every deal is community-voted (°) and marked when it expires — only active deals are used |
| Google News (UK) | Ticket-deal headlines | Only established UK publishers (BBC, Time Out, Evening Standard, MoneySavingExpert, …) |

Each deal gets a **score out of 100**: 30 % source trust, 35 % value (free / discount / lottery / rush / cheap),
25 % popularity (HotUKDeals votes, TodayTix ratings) and 10 % freshness.

## How it works

* `build_deals.py` reads the sources using the rules in `rules.json` and writes `deals.json`.
* A GitHub Action (`.github/workflows/refresh.yml`) runs it every 3 hours and commits the new `deals.json`;
  use **Actions → Refresh deals → Run workflow** for an instant refresh.
* `index.html` + `app.js` + `style.css` are the website (no build step); search, filters and the Lucky wheel run in the browser.
* The Mac and Windows apps use the same `rules.json` (they download it from this site) and search the sources live.
  See `SPEC.md`.

Run locally:

```bash
python3 build_deals.py && python3 -m http.server 8799
```

Prices and availability change fast — always check the final price on the seller's site. Not affiliated with any of these sites.
