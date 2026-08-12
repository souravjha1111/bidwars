# Bid Wars — a two-player auction & battle game

Draft a squad of characters against a friend in a live **auction**, then settle it
head-to-head in a **battle**. Two players, two devices, one winner. Built to be
played in person (you argue the battles out loud) over a shared Wi‑Fi network.

> Pick a theme — Marvel, Anime, Cricket, Football — draft 5 characters each by
> out-bidding your rival with a $100 budget, then clash them 1‑v‑1 and agree on
> who wins each point. Most points takes the match.

---

## How to run

You need [Node.js](https://nodejs.org) (v18+).

```bash
cd bidwars
npm install
npm start
```

Then open **http://localhost:3000**.

### Playing in person (two devices on the same Wi‑Fi)

1. On the computer running the server, find its LAN IP:
   - Windows: `ipconfig` → look for *IPv4 Address* (e.g. `192.168.1.24`)
   - macOS/Linux: `ifconfig` or `ip addr`
2. **Player 1** opens `http://localhost:3000`, enters a name, clicks **Create room**, and reads out the 4-letter code.
3. **Player 2** (on their phone/laptop) opens `http://<that-LAN-IP>:3000`, enters a name, types the code, and clicks **Join**.
4. The game starts automatically once both are in.

---

## The rules

**1. Category** — the host picks a theme. 10 characters are drawn at random from that category's 40 for the auction.

**2. Auction** — characters come up one at a time. Each player starts with **$100**.
- **Bid / Raise** — three buttons (**+$1**, **+$2**, **+$10**) push the price up by that amount and make you the top bidder.
- **Take it** means *"you can have it"* — you concede, and the current top bidder wins the card at their price.
- If nobody bids, **Skip** passes; a skipped card goes free to whoever has fewer cards.
- You can hold **at most 5 cards**. The moment one player fills their 5, every remaining card goes to the other player — so both always end with a squad of 5.

**3. Battle** — 5 rounds. Each round both players secretly pick one of their cards; they're revealed together.
- You're in the same room, so **argue it out** and both vote who wins.
- The point is only awarded when you **agree**. Disagree and you simply vote again.

**4. Result** — most points after 5 rounds wins. (5 rounds = no ties.)

---

## Adding images

Images are optional — until you add them, cards show the character's initial. To add art:

- Drop image files into `images/<category>/` named **`1.jpg`, `2.jpg`, … `40.jpg`**.
- The number matches the character's order in `data/<category>.json` (id `marvel-01` → `images/marvel/1.jpg`).
- `.jpg` is expected by the generated data; if you use `.png`, update the `image` fields in the JSON (or tweak `data/build-data.js` and re-run it).

Images are rendered in grayscale to keep the black‑and‑white look consistent.

## Adding or editing categories

All content lives in **`data/build-data.js`** as simple lists of
`[name, subcategory, one-line description]`. Edit the lists (or add a new
category object), then regenerate the JSON:

```bash
node data/build-data.js
```

This rewrites `data/<category>.json` and `data/index.json` (the catalog the app
reads). Restart the server to pick up changes.

---

## How it works (architecture)

```
Browser (Player A) ─┐
                    ├── Socket.IO ──► Node/Express server ──► authoritative game state per room
Browser (Player B) ─┘                        │
                                             └── broadcasts a full "state" snapshot to both clients on every change
```

- **Server is authoritative.** All rules (bids, budgets, the 5-card cap, battle
  scoring) run on the server in `server.js`. Clients never decide outcomes — they
  only send intents (`raise`, `takeIt`, `battlePick`, `battleVote`, …) and render.
- **Snapshot broadcasting.** Instead of fiddly incremental events, the server
  rebuilds a sanitized snapshot of the whole game and emits it to the room after
  every action. The client is a pure function of that snapshot, which keeps the
  two screens perfectly in sync and the client code simple.
- **Rooms.** Each game is a room keyed by a 4-letter code; players are seats
  **A** (host) and **B**. A disconnected seat can be reclaimed by re-joining with
  the same code.
- **Hidden information.** The only thing hidden is the current battle pick — the
  snapshot omits the actual card until *both* players have locked in, then reveals
  both at once. Everything else (who won which auction, budgets) is public, just
  as it is in a real in-person game.

### Socket events

| Client → Server | Meaning |
|---|---|
| `createRoom {name}` | make a room, become seat A |
| `joinRoom {code, name}` | join an existing room as seat B |
| `selectCategory {category}` | host starts the auction |
| `raise {amount}` | bump the current bid by +$1, +$2, or +$10 |
| `takeIt` | concede the card (or skip if no bids) |
| `battlePick {cardId}` | choose your card for the round |
| `battleVote {winner}` | vote which seat won (`"A"`/`"B"`) |
| `nextRound` | advance after a round result |
| `playAgain` | reset for a rematch |

| Server → Client | Meaning |
|---|---|
| `joined {code, seat}` | you're in; here's your seat |
| `state {…}` | full game snapshot — render from this |
| `errorMsg {text}` | a rejected action (e.g. can't afford) |

### Project layout

```
bidwars/
├── server.js            # Express + Socket.IO, all game logic
├── package.json
├── public/
│   ├── index.html       # the 6 screens (home, wait, category, auction, battle, result)
│   ├── styles.css       # black & white design system, dark by default
│   └── app.js           # socket wiring + renders each screen from the snapshot
├── data/
│   ├── build-data.js    # curated content → JSON generator
│   ├── index.json       # category catalog
│   └── <category>.json  # 40 entities each
└── images/<category>/   # optional numbered art (1.jpg … 40.jpg)
```

### Tech stack

Node.js · Express · Socket.IO · vanilla HTML/CSS/JS (no build step, no frontend
framework). Fonts: Fraunces (display) + Inter (body).

---

## Deploying

The game needs a **persistent WebSocket server**, so a static-only host (like a
plain Vercel static deploy) won't work. Good options:

- **Render** / **Railway** / **Fly.io** — point them at this repo, build command
  `npm install`, start command `npm start`. They set `PORT` automatically (the
  server reads `process.env.PORT`).
- **Azure App Service** (Node) — enable Web Sockets in the app settings.

For casual in-person play you don't need to deploy at all — just run it on one
laptop and have both players join over the same Wi‑Fi.

---

Made by **Sourav Jha**.
