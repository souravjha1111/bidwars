/*
 * Bid Wars — real-time two-player auction + battle game server.
 * Express serves the static client; Socket.IO carries all game events.
 * The server holds the authoritative state per room and broadcasts a full
 * sanitized snapshot ("state") to both players on every change.
 */
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const START_BALANCE = 100;
const BID_STEPS = [1, 2, 10]; // allowed bid increments
const CARDS_PER_PLAYER = 5;
const AUCTION_POOL = CARDS_PER_PLAYER * 2; // 10 cards, 5 each

// ---- static ----
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(path.join(__dirname, "images")));
app.use("/data", express.static(path.join(__dirname, "data")));

// ---- load category data into memory ----
const DATA_DIR = path.join(__dirname, "data");
const CATALOG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "index.json"), "utf8"));
const DATA = {};
for (const c of CATALOG) {
  DATA[c.id] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${c.id}.json`), "utf8"));
}

// ---- helpers ----
const rooms = {}; // code -> game

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function other(seat) {
  return seat === "A" ? "B" : "A";
}

function newGame(code) {
  return {
    code,
    phase: "lobby", // lobby -> category -> auction -> battle -> result
    category: null,
    players: {
      A: { seat: "A", id: null, name: "Player A", balance: START_BALANCE, cards: [], connected: false },
      B: { seat: "B", id: null, name: "Player B", balance: START_BALANCE, cards: [], connected: false },
    },
    hostSeat: "A",
    pool: [], // remaining undealt auction cards
    dealtTotal: 0,
    current: null, // card up for auction
    bid: 0,
    leader: null, // seat leading the bid
    passed: { A: false, B: false }, // no-leader "skip" tracking
    battle: null,
    winner: null,
    log: [],
  };
}

function logMsg(game, msg) {
  game.log.unshift(msg);
  if (game.log.length > 8) game.log.pop();
}

// ---- auction flow ----
function dealNext(game) {
  if (game.pool.length === 0) return startBattle(game);
  game.current = game.pool.shift();
  game.dealtTotal++;
  game.bid = 0;
  game.leader = null;
  game.passed = { A: false, B: false };
  game.phase = "auction";
}

function assignCard(game, seat, price) {
  const p = game.players[seat];
  const card = game.current;
  p.cards.push(card);
  p.balance -= price;
  logMsg(game, price > 0 ? `${p.name} won ${card.name} for $${price}.` : `${p.name} took ${card.name} (free).`);
  game.current = null;
  game.bid = 0;
  game.leader = null;

  // If this player is now full, dump the rest to the opponent, then battle.
  if (p.cards.length >= CARDS_PER_PLAYER) {
    const o = other(seat);
    while (game.pool.length && game.players[o].cards.length < CARDS_PER_PLAYER) {
      const c = game.pool.shift();
      game.players[o].cards.push(c);
      logMsg(game, `${game.players[o].name} auto-received ${c.name}.`);
    }
    game.pool = [];
    return startBattle(game);
  }
  return dealNext(game);
}

function bothSkip(game) {
  const a = game.players.A.cards.length;
  const b = game.players.B.cards.length;
  let seat;
  if (a < b) seat = "A";
  else if (b < a) seat = "B";
  else seat = Math.random() < 0.5 ? "A" : "B";
  logMsg(game, `Nobody bid — ${game.players[seat].name} gets ${game.current.name}.`);
  assignCard(game, seat, 0);
}

// ---- battle flow ----
function usedIds(game, seat) {
  return game.battle.history.filter((h) => h[seat === "A" ? "aCard" : "bCard"]).map((h) => h[seat === "A" ? "aCard" : "bCard"].id);
}

function startBattle(game) {
  game.phase = "battle";
  game.current = null;
  game.battle = {
    round: 1,
    stage: "pick", // pick -> vote -> reveal
    picks: { A: null, B: null },
    votes: { A: null, B: null },
    scores: { A: 0, B: 0 },
    history: [], // {round, aCard, bCard, winner}
    disagree: false,
    last: null, // {round, aCard, bCard, winner}
  };
  logMsg(game, "All cards dealt — battle time!");
}

function cardById(player, id) {
  return player.cards.find((c) => c.id === id) || null;
}

function resolveRoundIfReady(game) {
  const b = game.battle;
  if (b.picks.A && b.picks.B && b.stage === "pick") {
    b.stage = "vote";
    b.votes = { A: null, B: null };
    b.disagree = false;
  }
}

function finishGame(game) {
  const s = game.battle.scores;
  game.phase = "result";
  game.winner = s.A > s.B ? "A" : s.B > s.A ? "B" : "draw";
}

// ---- snapshot ----
function publicCard(card) {
  if (!card) return null;
  return { id: card.id, name: card.name, subcategory: card.subcategory, description: card.description, image: card.image };
}

function snapshot(game) {
  const p = game.players;
  const base = {
    code: game.code,
    phase: game.phase,
    category: game.category,
    catalog: CATALOG,
    hostSeat: game.hostSeat,
    players: {
      A: { seat: "A", name: p.A.name, balance: p.A.balance, connected: p.A.connected, cards: p.A.cards.map(publicCard) },
      B: { seat: "B", name: p.B.name, balance: p.B.balance, connected: p.B.connected, cards: p.B.cards.map(publicCard) },
    },
    log: game.log,
  };

  if (game.phase === "auction") {
    base.auction = {
      entity: publicCard(game.current),
      bid: game.bid,
      leader: game.leader,
      dealtTotal: game.dealtTotal,
      totalToDeal: AUCTION_POOL,
      cardsA: p.A.cards.length,
      cardsB: p.B.cards.length,
    };
  }

  if (game.phase === "battle" || game.phase === "result") {
    const b = game.battle;
    const revealNow = b.stage === "vote" || b.stage === "reveal";
    base.battle = {
      round: b.round,
      totalRounds: CARDS_PER_PLAYER,
      stage: b.stage,
      scores: b.scores,
      pickedA: !!b.picks.A,
      pickedB: !!b.picks.B,
      reveal: revealNow ? { A: publicCard(cardById(p.A, b.picks.A)), B: publicCard(cardById(p.B, b.picks.B)) } : null,
      votedA: !!b.votes.A,
      votedB: !!b.votes.B,
      disagree: b.disagree,
      last: b.last,
      history: b.history.map((h) => ({ round: h.round, aCard: publicCard(h.aCard), bCard: publicCard(h.bCard), winner: h.winner })),
      usedA: usedIds(game, "A"),
      usedB: usedIds(game, "B"),
    };
  }

  if (game.phase === "result") base.winner = game.winner;
  return base;
}

function broadcast(game) {
  io.to(game.code).emit("state", snapshot(game));
}

// ---- socket handlers ----
io.on("connection", (socket) => {
  socket.data.code = null;
  socket.data.seat = null;

  function fail(msg) {
    socket.emit("errorMsg", msg);
  }

  socket.on("createRoom", ({ name } = {}) => {
    const code = newCode();
    const game = newGame(code);
    rooms[code] = game;
    game.players.A.id = socket.id;
    game.players.A.connected = true;
    if (name && name.trim()) game.players.A.name = name.trim().slice(0, 16);
    socket.join(code);
    socket.data.code = code;
    socket.data.seat = "A";
    socket.emit("joined", { code, seat: "A" });
    broadcast(game);
  });

  socket.on("joinRoom", ({ code, name } = {}) => {
    code = (code || "").toUpperCase().trim();
    const game = rooms[code];
    if (!game) return fail("No room with that code.");
    // find an open or disconnected seat
    let seat = null;
    for (const s of ["A", "B"]) {
      if (!game.players[s].id || !game.players[s].connected) { seat = s; break; }
    }
    if (!seat) return fail("Room is full.");
    const wasEmpty = !game.players[seat].id;
    game.players[seat].id = socket.id;
    game.players[seat].connected = true;
    if (name && name.trim()) game.players[seat].name = name.trim().slice(0, 16);
    else if (wasEmpty) game.players[seat].name = seat === "A" ? "Player A" : "Player B";
    socket.join(code);
    socket.data.code = code;
    socket.data.seat = seat;
    socket.emit("joined", { code, seat });
    // once both connected and still in lobby, move to category selection
    if (game.phase === "lobby" && game.players.A.connected && game.players.B.connected) {
      game.phase = "category";
    }
    logMsg(game, `${game.players[seat].name} joined.`);
    broadcast(game);
  });

  socket.on("selectCategory", ({ category } = {}) => {
    const game = rooms[socket.data.code];
    if (!game) return;
    if (socket.data.seat !== game.hostSeat) return fail("Only the host picks the category.");
    if (game.phase !== "category") return;
    if (!DATA[category]) return fail("Unknown category.");
    game.category = category;
    game.pool = shuffle(DATA[category]).slice(0, AUCTION_POOL);
    game.dealtTotal = 0;
    logMsg(game, `Category: ${CATALOG.find((c) => c.id === category).label}.`);
    dealNext(game);
    broadcast(game);
  });

  socket.on("raise", (payload) => {
    const game = rooms[socket.data.code];
    if (!game || game.phase !== "auction" || !game.current) return;
    const seat = socket.data.seat;
    const inc = payload && Number(payload.amount);
    if (!BID_STEPS.includes(inc)) return fail("Invalid bid increment.");
    const newBid = game.bid + inc;
    if (game.players[seat].balance < newBid) return fail("Not enough money to raise.");
    game.bid = newBid;
    game.leader = seat;
    game.passed = { A: false, B: false };
    broadcast(game);
  });

  socket.on("takeIt", () => {
    const game = rooms[socket.data.code];
    if (!game || game.phase !== "auction" || !game.current) return;
    const seat = socket.data.seat;
    if (game.leader && game.leader !== seat) {
      // presser concedes -> the leader wins at current bid
      assignCard(game, game.leader, game.bid);
      broadcast(game);
    } else if (!game.leader) {
      // nobody has bid: this is a "skip"
      game.passed[seat] = true;
      if (game.passed.A && game.passed.B) bothSkip(game);
      broadcast(game);
    }
    // if the leader presses take_it we ignore (they're already winning; wait for opponent)
  });

  socket.on("battlePick", ({ cardId } = {}) => {
    const game = rooms[socket.data.code];
    if (!game || game.phase !== "battle") return;
    const b = game.battle;
    if (b.stage !== "pick") return;
    const seat = socket.data.seat;
    const player = game.players[seat];
    if (!cardById(player, cardId)) return fail("That card isn't yours.");
    if (usedIds(game, seat).includes(cardId)) return fail("That card was already played.");
    b.picks[seat] = cardId;
    resolveRoundIfReady(game);
    broadcast(game);
  });

  socket.on("battleVote", ({ winner } = {}) => {
    const game = rooms[socket.data.code];
    if (!game || game.phase !== "battle") return;
    const b = game.battle;
    if (b.stage !== "vote") return;
    if (winner !== "A" && winner !== "B") return;
    const seat = socket.data.seat;
    b.votes[seat] = winner;
    if (b.votes.A && b.votes.B) {
      if (b.votes.A === b.votes.B) {
        const w = b.votes.A;
        b.scores[w]++;
        const rec = { round: b.round, aCard: cardById(game.players.A, b.picks.A), bCard: cardById(game.players.B, b.picks.B), winner: w };
        b.history.push(rec);
        b.last = { round: b.round, aCard: publicCard(rec.aCard), bCard: publicCard(rec.bCard), winner: w };
        b.stage = "reveal";
        b.disagree = false;
        logMsg(game, `Round ${b.round}: ${game.players[w].name} wins the point.`);
      } else {
        // disagreement -> clear votes and re-vote
        b.votes = { A: null, B: null };
        b.disagree = true;
      }
    }
    broadcast(game);
  });

  socket.on("nextRound", () => {
    const game = rooms[socket.data.code];
    if (!game || game.phase !== "battle") return;
    const b = game.battle;
    if (b.stage !== "reveal") return;
    if (b.round >= CARDS_PER_PLAYER) {
      finishGame(game);
    } else {
      b.round++;
      b.stage = "pick";
      b.picks = { A: null, B: null };
      b.votes = { A: null, B: null };
      b.disagree = false;
    }
    broadcast(game);
  });

  socket.on("playAgain", () => {
    const game = rooms[socket.data.code];
    if (!game) return;
    for (const s of ["A", "B"]) {
      game.players[s].balance = START_BALANCE;
      game.players[s].cards = [];
    }
    game.category = null;
    game.pool = [];
    game.dealtTotal = 0;
    game.current = null;
    game.bid = 0;
    game.leader = null;
    game.battle = null;
    game.winner = null;
    game.phase = game.players.A.connected && game.players.B.connected ? "category" : "lobby";
    logMsg(game, "New game — pick a category.");
    broadcast(game);
  });

  socket.on("disconnect", () => {
    const game = rooms[socket.data.code];
    if (!game) return;
    const seat = socket.data.seat;
    if (seat && game.players[seat].id === socket.id) {
      game.players[seat].connected = false;
      logMsg(game, `${game.players[seat].name} disconnected.`);
      broadcast(game);
    }
    // clean up empty rooms
    if (!game.players.A.connected && !game.players.B.connected) {
      delete rooms[game.code];
    }
  });
});

server.listen(PORT, () => {
  console.log(`Bid Wars running at http://localhost:${PORT}`);
});
