/* Bid Wars — client. Connects via Socket.IO, renders each screen from the
 * authoritative "state" snapshot the server broadcasts. No frameworks. */
(function () {
  "use strict";
  var socket = io();

  var me = { code: null, seat: null };
  var last = null;

  // ---------- tiny helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  }); }
  function initial(name) { return esc((name || "?").trim().charAt(0).toUpperCase()); }

  window.imgFallback = function (img, ch) {
    var w = img.parentNode;
    if (w) w.innerHTML = '<span class="ph">' + ch + "</span>";
  };

  function imgWrap(card, extraClass) {
    var ch = initial(card.name);
    return '<div class="img-wrap ' + (extraClass || "") + '">' +
      '<img src="/' + esc(card.image) + '" alt="' + esc(card.name) +
      '" onerror="imgFallback(this,\'' + ch + '\')"></div>';
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    var el = $(id);
    if (el) el.classList.add("active");
  }

  function myPlayer(st) { return st.players[me.seat]; }
  function oppSeat() { return me.seat === "A" ? "B" : "A"; }

  // ---------- home ----------
  $("btn-create").addEventListener("click", function () {
    socket.emit("createRoom", { name: $("name-input").value });
  });
  $("btn-join").addEventListener("click", doJoin);
  function doJoin() {
    var code = $("code-input").value.toUpperCase().trim();
    if (code.length !== 4) { showErr("Enter the 4-letter room code."); return; }
    socket.emit("joinRoom", { code: code, name: $("name-input").value });
  }
  $("code-input").addEventListener("input", function () {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  $("code-input").addEventListener("keydown", function (e) { if (e.key === "Enter") doJoin(); });
  function showErr(m) { var e = $("home-err"); e.textContent = m; e.hidden = false; }

  // ---------- socket events ----------
  socket.on("joined", function (d) {
    me.code = d.code; me.seat = d.seat;
    $("room-chip").hidden = false;
    $("room-code").textContent = d.code;
    $("home-err").hidden = true;
  });
  socket.on("errorMsg", function (msg) {
    toast(msg);
    if ($("screen-home").classList.contains("active")) showErr(msg);
  });
  socket.on("state", function (st) { last = st; render(st); });

  // ---------- master render ----------
  function render(st) {
    switch (st.phase) {
      case "lobby": renderWait(st); break;
      case "category": renderCategory(st); break;
      case "auction": renderAuction(st); break;
      case "battle": renderBattle(st); break;
      case "result": renderResult(st); break;
      default: showScreen("screen-home");
    }
  }

  // ---------- waiting ----------
  function renderWait(st) {
    showScreen("screen-wait");
    $("wait-code").textContent = st.code;
    var opp = st.players[oppSeat()];
    $("wait-status").textContent = opp && opp.connected ? "Opponent connected…" : "Waiting for opponent…";
  }

  // ---------- category ----------
  function renderCategory(st) {
    showScreen("screen-category");
    var isHost = me.seat === st.hostSeat;
    var grid = $("cat-grid");
    grid.innerHTML = st.catalog.map(function (c) {
      return '<button class="cat-btn" data-cat="' + esc(c.id) + '"' + (isHost ? "" : " disabled") + ">" +
        '<div class="c-name">' + esc(c.label) + "</div>" +
        '<div class="c-count">' + c.count + " entities</div></button>";
    }).join("");
    $("cat-wait").hidden = isHost;
    if (isHost) {
      grid.querySelectorAll(".cat-btn").forEach(function (b) {
        b.addEventListener("click", function () {
          socket.emit("selectCategory", { category: b.getAttribute("data-cat") });
        });
      });
    }
  }

  // ---------- players bar (auction) ----------
  function playerCard(st, seat, opts) {
    var p = st.players[seat];
    var cls = "pcard" + (seat === me.seat ? " me" : "");
    if (opts && opts.leader === seat) cls += " leading";
    var chips = p.cards.map(function (c) { return '<span class="mini">' + esc(c.name) + "</span>"; }).join("");
    var disc = p.connected ? "" : ' <span class="disc">offline</span>';
    return '<div class="' + cls + '">' +
      '<div class="p-top"><div class="p-name">' + esc(p.name) +
      (seat === me.seat ? '<span class="you">YOU</span>' : "") + disc + "</div>" +
      '<div class="p-bal">$' + p.balance + "</div></div>" +
      '<div class="p-sub">' + p.cards.length + "/5 cards</div>" +
      '<div class="p-cards">' + chips + "</div></div>";
  }

  // ---------- auction ----------
  function renderAuction(st) {
    showScreen("screen-auction");
    var a = st.auction;
    $("auction-players").innerHTML = playerCard(st, "A", { leader: a.leader }) + playerCard(st, "B", { leader: a.leader });

    $("deal-count").textContent = "Card " + a.dealtTotal + " of " + a.totalToDeal;

    var e = a.entity;
    $("entity").innerHTML = imgWrap(e) +
      '<div class="e-body"><span class="e-tag">' + esc(e.subcategory) + "</span>" +
      '<div class="e-name">' + esc(e.name) + "</div>" +
      '<div class="e-desc">' + esc(e.description) + "</div></div>";

    // bid state
    var bs = $("bid-state");
    if (!a.leader) {
      bs.innerHTML = '<div class="bid-lead">No bids yet — open the bidding.</div>';
    } else {
      var leadName = st.players[a.leader].name + (a.leader === me.seat ? " (you)" : "");
      bs.innerHTML = '<div class="bid-amt">$' + a.bid + "</div>" +
        '<div class="bid-lead"><b>' + esc(leadName) + "</b> leads</div>";
    }

    // controls
    var c = $("auction-controls");
    var myBal = myPlayer(st).balance;
    c.innerHTML = "";
    var STEPS = [1, 2, 10];
    function bidButtons() {
      STEPS.forEach(function (inc) {
        addBtn(c, "+$" + inc, "btn-solid", myBal < (a.bid + inc), function () {
          socket.emit("raise", { amount: inc });
        });
      });
    }
    if (!a.leader) {
      bidButtons();
      addBtn(c, "Skip", "btn-ghost", false, function () { socket.emit("takeIt"); });
      if (myBal < STEPS[0]) hint(c, "You can't afford to bid.");
    } else if (a.leader === me.seat) {
      hint(c, "You lead at $" + a.bid + " — waiting for opponent…");
    } else {
      bidButtons();
      addBtn(c, "Take it ($" + a.bid + " to them)", "btn-ghost", false, function () { socket.emit("takeIt"); });
      if (myBal < (a.bid + STEPS[0])) hint(c, "Not enough to raise — you can concede.");
    }

    $("auction-log").innerHTML = st.log.map(function (l) { return "<div>" + esc(l) + "</div>"; }).join("");
  }

  function addBtn(parent, label, cls, disabled, fn) {
    var b = document.createElement("button");
    b.className = "btn btn-lg " + cls;
    b.textContent = label;
    b.disabled = !!disabled;
    if (!disabled) b.addEventListener("click", fn);
    parent.appendChild(b);
  }
  function hint(parent, text) {
    var d = document.createElement("div");
    d.className = "hint";
    d.textContent = text;
    parent.appendChild(d);
  }

  // ---------- battle ----------
  function renderBattle(st) {
    showScreen("screen-battle");
    var b = st.battle;
    var pA = st.players.A, pB = st.players.B;

    $("score-a").className = "score" + (me.seat === "A" ? " me" : "");
    $("score-a").innerHTML = '<div class="s-name">' + esc(pA.name) + '</div><div class="s-num">' + b.scores.A + "</div>";
    $("score-b").className = "score" + (me.seat === "B" ? " me" : "");
    $("score-b").innerHTML = '<div class="s-name">' + esc(pB.name) + '</div><div class="s-num">' + b.scores.B + "</div>";
    $("round-info").textContent = "Round " + b.round + " / " + b.totalRounds;

    var pickedMe = me.seat === "A" ? b.pickedA : b.pickedB;
    var pickedOpp = me.seat === "A" ? b.pickedB : b.pickedA;
    var votedMe = me.seat === "A" ? b.votedA : b.votedB;

    // stage
    var stage = $("battle-stage");
    if (b.stage === "pick") {
      stage.innerHTML =
        slotStatus("A", pA.name, me.seat === "A" ? (pickedMe ? "Locked in ✓" : "Choose below") : (b.pickedA ? "Locked in ✓" : "Choosing…")) +
        '<div class="vs">vs</div>' +
        slotStatus("B", pB.name, me.seat === "B" ? (pickedMe ? "Locked in ✓" : "Choose below") : (b.pickedB ? "Locked in ✓" : "Choosing…"));
    } else {
      // vote or reveal — both cards shown
      var winA = b.stage === "reveal" && b.last && b.last.winner === "A";
      var winB = b.stage === "reveal" && b.last && b.last.winner === "B";
      stage.innerHTML =
        slotCard("A", pA.name, b.reveal.A, winA) +
        '<div class="vs">vs</div>' +
        slotCard("B", pB.name, b.reveal.B, winB);
    }

    // controls
    var c = $("battle-controls");
    c.innerHTML = "";
    if (b.stage === "pick") {
      if (pickedMe) hint(c, pickedOpp ? "Both locked in…" : "Waiting for opponent to pick…");
      else hint(c, "Pick one of your cards to send into battle.");
    } else if (b.stage === "vote") {
      if (b.disagree) { var d = document.createElement("div"); d.className = "disagree"; d.textContent = "You two disagreed — talk it out and vote again."; c.appendChild(d); }
      if (votedMe) {
        hint(c, "Waiting for the other player to agree…");
      } else {
        addBtn(c, esc0(b.reveal.A.name) + " wins", "btn-solid", false, function () { socket.emit("battleVote", { winner: "A" }); });
        addBtn(c, esc0(b.reveal.B.name) + " wins", "btn-solid", false, function () { socket.emit("battleVote", { winner: "B" }); });
      }
    } else if (b.stage === "reveal") {
      var wname = st.players[b.last.winner].name;
      hint(c, wname + " takes the point.");
      addBtn(c, b.round >= b.totalRounds ? "See result" : "Next round", "btn-solid", false, function () { socket.emit("nextRound"); });
    }

    // my hand
    renderHand(st, b);
  }
  function esc0(s) { return String(s == null ? "" : s); }

  function slotStatus(seat, owner, status) {
    return '<div class="slot"><div class="s-who">' + esc(owner) + "</div>" +
      '<div class="s-ds">' + esc(status) + "</div></div>";
  }
  function slotCard(seat, owner, card, win) {
    if (!card) return slotStatus(seat, owner, "…");
    return '<div class="slot filled' + (win ? " win" : "") + '">' +
      '<div class="s-who">' + esc(owner) + "</div>" +
      imgWrap(card) +
      '<div class="s-nm">' + esc(card.name) + "</div>" +
      '<div class="s-ds">' + esc(card.description) + "</div>" +
      (win ? '<span class="badge-win">WON</span>' : "") + "</div>";
  }

  function renderHand(st, b) {
    var wrap = $("hand-wrap");
    var hand = myPlayer(st).cards;
    var used = me.seat === "A" ? b.usedA : b.usedB;
    var pickedMe = me.seat === "A" ? b.pickedA : b.pickedB;
    var canPick = b.stage === "pick" && !pickedMe;

    var cards = hand.map(function (card) {
      var isUsed = used.indexOf(card.id) !== -1;
      var cls = "hcard" + (isUsed || !canPick ? " disabled" : "");
      var html = '<div class="' + cls + '" data-id="' + esc(card.id) + '">' +
        imgWrap(card) + '<div class="h-nm">' + esc(card.name) + "</div></div>";
      return html;
    }).join("");

    wrap.innerHTML = '<div class="hand-title">Your squad</div><div class="hand">' + cards + "</div>";

    if (canPick) {
      wrap.querySelectorAll(".hcard:not(.disabled)").forEach(function (el) {
        el.addEventListener("click", function () {
          socket.emit("battlePick", { cardId: el.getAttribute("data-id") });
        });
      });
    }
  }

  // ---------- result ----------
  function renderResult(st) {
    showScreen("screen-result");
    var b = st.battle;
    var pA = st.players.A, pB = st.players.B;
    var wl = $("winner-line");
    if (st.winner === "draw") wl.textContent = "It's a draw.";
    else {
      var w = st.players[st.winner];
      wl.textContent = w.name + " wins!";
    }
    $("final-score").textContent = pA.name + "  " + b.scores.A + " – " + b.scores.B + "  " + pB.name;

    $("recap").innerHTML = b.history.map(function (h) {
      var wn = h.winner === "A" ? pA.name : pB.name;
      return '<div class="r-row"><span>R' + h.round + ": " + esc(h.aCard.name) + " vs " + esc(h.bCard.name) +
        '</span><span class="r-win">' + esc(wn) + "</span></div>";
    }).join("");
  }

  $("btn-again").addEventListener("click", function () { socket.emit("playAgain"); });
})();
