# Robinhood Chain — NFT Watch

A desktop app (Windows/macOS/Linux via Electron) that watches NFT collections on **Robinhood Chain** through OpenSea's public API: live floor price, 24h volume, owners, sales activity, and background alerts for big moves — with native OS notifications, even when the window is closed.

> **Not affiliated with Robinhood Markets, Inc. or OpenSea.** This is an independent, unofficial tool built on top of their public APIs.

## Features

- Verified / Unverified / Owned (your own watchlist) columns, each with floor price, 24h floor high, owners, sales in the last hour, and collection size
- Trend arrows on key stats between checks
- Background polling via a system tray process — closing the window doesn't stop it
- Native Windows/macOS/Linux notifications on big floor or volume moves, with a click-through link to the collection on OpenSea (and to the collection's latest tweet, if an X/Twitter API token is configured)
- Search bar to add any collection to your Owned watchlist by name, slug, or OpenSea URL
- Only tracks ETH-denominated collections — USDG-priced collections are automatically filtered out (see below)

## Running it

```bash
npm install
npm start
```

## Building a distributable

```bash
npm run build:win     # → dist/RobinhoodChainDashboard-win32-x64
npm run build:mac     # → dist/RobinhoodChainDashboard-darwin-x64 / -arm64
npm run build:linux   # → dist/RobinhoodChainDashboard-linux-x64
```

Each produces an unsigned, portable app folder. Zip the whole folder to distribute it — the executable depends on the files next to it.

**Unsigned builds will trigger your OS's "unknown publisher" warning** on first launch (SmartScreen on Windows, Gatekeeper on macOS). That's expected without a paid code-signing certificate.

## About the OpenSea API key

**By default, you don't need to do anything.** The app automatically requests a free-tier OpenSea API key straight from OpenSea's own instant-key endpoint (`POST /api/v2/auth/keys` — [documented here](https://docs.opensea.io/reference/api-keys)): no signup, no email, no human step. That key is good for 7 days at 600 read / 30 write requests per hour, and the app silently fetches a replacement about an hour before it expires — so it just keeps working.

This is controlled by the **"Automatically get a free OpenSea API key"** checkbox in Settings (on by default). It shows whether an auto-key is currently active and when it next renews. Uncheck it at any time to paste in your own personal key instead — useful if you want higher rate limits than the free tier, since [applying for a personal key](https://docs.opensea.io/reference/api-keys) removes those limits. The manual key field is disabled while the auto-key is active, and re-enables the moment you uncheck the box.

Either way, keys live only in your own machine's local app-data folder — never in this repository.

**Rate limit math:** the app now tracks up to **20 collections** (down from 50) on a **15-minute** check interval by default. Each collection costs 4 API calls per check in the typical case — collection stats, sales-in-the-last-hour, supply detail, and top offer — plus 1 shared call per check to fetch the tracked-collections list itself:

- **Typical:** 1 + (20 × 4) = 81 calls/poll → × 4 polls/hour = **~324 reads/hour**, about 54% of the auto-key's 600 reads/hour limit.
- **Worst case:** if every single tracked collection has 200+ sales in the last hour (each sales-lookup then paginates up to 5 calls instead of 1), that's 1 + (20 × 8) = 161 calls/poll → **~644 reads/hour**, slightly over the limit. This is an unlikely edge case (all 20 collections trading heavily at once), and an occasional `429` here just gets skipped for that collection until the next poll — it doesn't break anything.

So at these defaults there's comfortable headroom on the free auto-key for normal use, with only a narrow, unlikely edge case that could brush against the limit. If you add many collections to Owned on top of the tracked 20, or drop the interval below 15 minutes, redo this math or switch to a personal key with higher limits.

## About the X/Twitter integration

Optional. OpenSea has no free way to look up an account's latest tweet, so this requires your own X API bearer token (X's API is a paid product) pasted into Settings. Without one, big-move notifications still fire — they just link to the collection on OpenSea instead of a tweet.

## About "Owned"

This is a **manually curated watchlist**, not a wallet scan. The app has no wallet connection and can't know what you actually hold on-chain — right-click any collection to add or remove it from Owned.

## About the USDG filter

Robinhood Chain collections can be priced in ETH or in **USDG** (a stablecoin). This app is built around ETH-denominated floor prices, volume, and offers — mixing the two would make the numbers meaningless (a "floor" in USDG isn't comparable to a "floor" in ETH). So USDG-denominated collections are automatically excluded everywhere: the Verified/Unverified feed, and the Owned search bar (trying to add one shows an explanation instead of adding it). This is checked via OpenSea's `floor_price_symbol` field, with a fallback check against the collection's accepted payment tokens for the rare case a collection has no active listings to derive a floor price from.

## Checking for updates

The **"⟳ Check for Updates"** button (top right) hits GitHub's public Releases API for this repo, compares the latest published tag against the version this build was packaged with, and links straight to the release page to download a newer one if available.

This requires the GitHub repo to be **Public**. GitHub's API returns nothing for a private repo's releases unless the request is authenticated, and this app deliberately never ships a GitHub token inside the app itself — anyone who extracted the app could pull that token out and use it, which would be a real problem for a private repo. If the repo stays Private, this button will show an error instead of finding the release.

If you ever rename or move the repo, update the `GITHUB_REPO` constant near the top of `main.js` to match.

## Known limitations

- "24h floor high" is tracked by the app itself (OpenSea's API doesn't expose historical floor data), so it only becomes meaningful after the app has been running for a while
- Twitter handle discovery scrapes the public OpenSea collection page rather than relying on an API field, since that field isn't reliably populated
- No auto-update mechanism — new versions must be manually redistributed

## License

MIT — see [LICENSE](./LICENSE).
