# Remote Card Table

This is a browser app for two people playing from different locations. It includes heads-up Spades, a two-player Hand & Foot table, and heads-up Texas Hold'em with simulated play-chip betting.

The reliable remote-play version should be hosted on the internet. That gives both players one permanent link and avoids tunnel failures when the host Mac changes Wi-Fi networks.

## How to Play Remotely

1. Put the files somewhere both players can open the same app, such as a simple static web host, shared folder, or one player's computer during a video call.
2. Player 1 opens the app and clicks **Host room**.
3. Player 1 shares the room code with Player 2 by text, phone, or video chat.
4. Player 2 opens the app, enters the room code, and clicks **Join**.
5. Player 1 sits South and Player 2 sits North.
6. Draft hands from the deck: on your turn, look at the first card and choose **Keep** or **Discard**.
7. If you keep the first card, the next card is discarded. If you discard the first card, you automatically keep the next card.
8. When the deck is exhausted, bid and play heads-up Spades.
9. Extra tricks are bags. Every 5 bags costs 50 points, and leftover bags carry forward.

Use the **Hand & Foot** link in the top bar to switch games. Hand & Foot uses four decks, 11 cards in Hand and Foot, round draws of 2/3/4/5, opening melds of 50/90/120/150, matching clean and dirty book requirements of 2/3/4/5, frozen discard piles when a wild is present, and the red/black 3 rules from your house rules.

Use the **Hold'em** link for two-player Texas Hold'em. It uses play chips only, with no deposits, cash value, buy-ins, or payouts. The table follows heads-up blind order: the dealer posts the small blind and acts first preflop, then the big blind acts first on the flop, turn, and river. Betting supports check, call, fold, bet, raise, and all-in actions with automatic showdown scoring.

## Hosted Version

The hosted server is `hosted-server.js`. It serves the card table and provides the `/api/rooms` relay used by both games.

Deploy this folder as a Node web service with:

```sh
npm start
```

The host should use Node 18 or newer. `render.yaml` is included for Render-style deployment.

After deployment, both players open the same permanent site URL:

```text
https://your-card-table-host.example.com
```

Spades is at `/`; Hand & Foot is at `/handfoot.html`; Hold'em is at `/texas.html`.

## Running Locally For Testing

From this folder:

```sh
npm start
```

Then open:

```text
http://localhost:4173
```

The old tunnel method is no longer recommended for real play.

## macOS App

The packaged app lives at:

```text
dist/Remote Spades.app
```

Double-click it to open the card table in your browser.

Once you have a hosted URL, point the app icon at it:

```sh
packaging/set_hosted_url.sh https://your-card-table-host.example.com
```

After that, the icon opens the permanent hosted table instead of starting a temporary tunnel.

To rebuild the app after changing the source files:

```sh
packaging/build_app.sh
```

## Temporary Tunnel

The packaged app can still fall back to temporary tunnels if no hosted URL is configured, but this is only a developer fallback. It is not dependable enough for regular remote play.
