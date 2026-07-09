const seats = ["south", "north"];
const seatNames = { south: "South", north: "North" };
const humanSeats = { host: "south", guest: "north" };
const suitSymbols = { S: "♠", H: "♥", D: "♦", C: "♣", J: "★" };
const rankOrder = { 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14, 2: 15, X: 16 };
const roundRules = [
  { draw: 2, open: 50, books: 2 },
  { draw: 3, open: 90, books: 3 },
  { draw: 4, open: 120, books: 4 },
  { draw: 5, open: 150, books: 5 },
];

const els = {
  hostBtn: document.querySelector("#hostBtn"),
  copyBtn: document.querySelector("#copyBtn"),
  joinBtn: document.querySelector("#joinBtn"),
  roomInput: document.querySelector("#roomInput"),
  connectionStatus: document.querySelector("#connectionStatus"),
  seatStatus: document.querySelector("#seatStatus"),
  roomStatus: document.querySelector("#roomStatus"),
  southScore: document.querySelector("#southScore"),
  northScore: document.querySelector("#northScore"),
  roundStatus: document.querySelector("#roundStatus"),
  seatNorth: document.querySelector("#seatNorth"),
  seatSouth: document.querySelector("#seatSouth"),
  stockBtn: document.querySelector("#stockBtn"),
  discardBtn: document.querySelector("#discardBtn"),
  stockCount: document.querySelector("#stockCount"),
  discardTop: document.querySelector("#discardTop"),
  discardCount: document.querySelector("#discardCount"),
  gameMessage: document.querySelector("#gameMessage"),
  actionControls: document.querySelector("#actionControls"),
  newRoundBtn: document.querySelector("#newRoundBtn"),
  newGameBtn: document.querySelector("#newGameBtn"),
  handLabel: document.querySelector("#handLabel"),
  turnStatus: document.querySelector("#turnStatus"),
  hand: document.querySelector("#hand"),
  southMelds: document.querySelector("#southMelds"),
  northMelds: document.querySelector("#northMelds"),
};

let role = null;
let mySeat = null;
let syncMode = "peer";
let pollTimer = null;
let selected = new Set();
let state = createGame();
let peer = null;
let peerConn = null;

function createDeck() {
  const ranks = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
  const suits = ["S", "H", "D", "C"];
  const deck = [];
  for (let d = 0; d < 4; d += 1) {
    suits.forEach((suit) => ranks.forEach((rank) => deck.push({ id: `${rank}${suit}-${d}`, rank, suit })));
    deck.push({ id: `XJ-a-${d}`, rank: "X", suit: "J" }, { id: `XJ-b-${d}`, rank: "X", suit: "J" });
  }
  return deck;
}

function shuffle(deck) {
  const cards = [...deck];
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function createGame(previous = null) {
  const deck = shuffle(createDeck());
  const round = previous ? Math.min(previous.round + 1, 4) : 1;
  const players = {
    south: { hand: deck.splice(0, 11), foot: deck.splice(0, 11), active: "hand", melds: [], opened: false },
    north: { hand: deck.splice(0, 11), foot: deck.splice(0, 11), active: "hand", melds: [], opened: false },
  };
  return {
    game: "handfoot",
    round,
    scores: previous ? previous.scores : { south: 0, north: 0 },
    stock: deck,
    discard: [deck.shift()],
    players,
    currentTurn: "south",
    turnStage: "firstDiscard",
    wentOut: null,
    message: "South may take the first discard card, or skip it and draw normally.",
  };
}

function rule() {
  return roundRules[state.round - 1];
}

function activeCards(seat) {
  const player = state.players[seat];
  return player[player.active];
}

function setActiveCards(seat, cards) {
  state.players[seat][state.players[seat].active] = cards;
}

function hostRoom() {
  if (syncMode !== "server") {
    hostPeerRoom();
    return;
  }
  role = "host";
  mySeat = humanSeats.host;
  createRoom();
}

function makeRoomCode(prefix) {
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function hostPeerRoom() {
  role = "host";
  mySeat = humanSeats.host;
  const code = makeRoomCode("CARDS");
  setConnection("Creating room...");
  peer = new Peer(code);
  peer.on("open", (id) => {
    els.roomInput.value = id.toUpperCase();
    setConnection("Room ready");
    render();
  });
  peer.on("connection", (conn) => {
    peerConn = conn;
    wireHostPeerConnection(conn);
  });
  peer.on("error", (error) => {
    setConnection(error.type === "unavailable-id" ? "Room collision. Try Host again." : "Peer relay error");
    role = null;
    mySeat = null;
    render();
  });
}

function wireHostPeerConnection(conn) {
  conn.on("open", () => {
    setConnection("Connected");
    sendPeerState(conn);
    [300, 900, 1800].forEach((delay) => setTimeout(() => sendPeerState(conn), delay));
  });
  conn.on("data", (message) => {
    if (message.type === "requestState") sendPeerState(conn);
    if (message.type === "state") {
      state = message.state;
      render();
      sendPeerState();
    }
  });
  conn.on("close", () => setConnection("Partner disconnected. Keep this page open and have them rejoin."));
}

function wireGuestPeerConnection(conn) {
  conn.on("open", () => {
    setConnection("Connected");
    conn.send({ type: "requestState" });
    render();
  });
  conn.on("data", (message) => {
    if (message.type === "state") {
      state = message.state;
      render();
    }
  });
  conn.on("close", () => setConnection("Host disconnected. Ask host to keep the room page open."));
}

function sendPeerState(conn = peerConn) {
  if (conn?.open) conn.send({ type: "state", state });
}

async function createRoom() {
  setConnection("Creating room...");
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  const payload = await response.json();
  els.roomInput.value = payload.room;
  setConnection("Room ready");
  startPolling(payload.room);
  render();
}

async function joinRoom() {
  if (syncMode !== "server") {
    joinPeerRoom();
    return;
  }
  const room = els.roomInput.value.trim().toUpperCase();
  if (!room) return setConnection("Enter a room code");
  role = "guest";
  mySeat = humanSeats.guest;
  setConnection("Connecting...");
  const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/state`);
  if (!response.ok) {
    role = null;
    mySeat = null;
    setConnection("Room not found");
    render();
    return;
  }
  state = (await response.json()).state;
  setConnection("Connected");
  startPolling(room);
  render();
}

function joinPeerRoom() {
  const room = els.roomInput.value.trim().toUpperCase();
  if (!room) return setConnection("Enter a room code");
  role = "guest";
  mySeat = humanSeats.guest;
  setConnection("Connecting...");
  peer = new Peer();
  peer.on("open", () => {
    peerConn = peer.connect(room, { reliable: true });
    wireGuestPeerConnection(peerConn);
  });
  peer.on("error", () => {
    setConnection("Peer relay error");
    role = null;
    mySeat = null;
    render();
  });
  render();
}

function startPolling(room) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/state`);
    if (!response.ok) return;
    state = (await response.json()).state;
    render();
  }, 650);
}

async function broadcast() {
  render();
  if (syncMode === "peer" && peerConn?.open) {
    sendPeerState();
    return;
  }
  const room = els.roomInput.value.trim().toUpperCase();
  if (!room || syncMode !== "server" || !role) return;
  await fetch(`/api/rooms/${encodeURIComponent(room)}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  }).catch(() => setConnection("Relay update failed"));
}

function setConnection(text) {
  els.connectionStatus.textContent = text;
}

function takeStock() {
  if (!isMyTurn() || state.turnStage !== "draw") return;
  const amount = Math.min(rule().draw, state.stock.length);
  activeCards(mySeat).push(...state.stock.splice(0, amount));
  state.turnStage = "play";
  state.message = `${seatNames[mySeat]} drew ${amount} from stock.`;
  broadcast();
}

function takeFirstDiscard() {
  if (!isMyTurn() || state.turnStage !== "firstDiscard" || !state.discard[0]) return;
  const card = state.discard.shift();
  activeCards(mySeat).push(card);
  state.turnStage = "play";
  state.message = `${seatNames[mySeat]} took the first discard. Discard one card to finish the turn.`;
  broadcast();
}

function skipFirstDiscard() {
  if (!isMyTurn() || state.turnStage !== "firstDiscard") return;
  state.turnStage = "draw";
  state.message = `${seatNames[mySeat]} skipped the first discard. Draw from stock or pick up the discard pile.`;
  broadcast();
}

function takeDiscard() {
  if (!isMyTurn() || state.turnStage !== "draw" || !canTakeDiscard(mySeat).ok) return;
  const count = Math.min(5, state.discard.length);
  activeCards(mySeat).push(...state.discard.splice(0, count));
  state.turnStage = "play";
  state.message = `${seatNames[mySeat]} picked up ${count} from discard.`;
  broadcast();
}

function canTakeDiscard(seat) {
  const top = state.discard[0];
  if (!top) return { ok: false, reason: "Discard is empty" };
  if (state.discard.some(isWild)) return { ok: false, reason: "Discard pile is frozen by a wild card" };
  const matches = activeCards(seat).filter((card) => card.rank === top.rank && !isWild(card));
  if (matches.length < 2) return { ok: false, reason: `Need two natural ${rankName(top.rank)}s` };
  return { ok: true };
}

function meldSelected(targetIndex = null) {
  if (!isMyTurn() || state.turnStage !== "play") return;
  const cards = selectedCards();
  if (!cards.length) return;
  const player = state.players[mySeat];
  const active = activeCards(mySeat);
  const result = targetIndex === null ? validateNewMeld(cards, player) : validateAddMeld(cards, player.melds[targetIndex]);
  if (!result.ok) {
    state.message = result.reason;
    render();
    return;
  }
  setActiveCards(mySeat, active.filter((card) => !selected.has(card.id)));
  if (targetIndex === null) {
    player.melds.push({ rank: result.rank, cards });
  } else {
    player.melds[targetIndex].cards.push(...cards);
  }
  if (!player.opened && openingTotal(player.melds) >= rule().open) player.opened = true;
  selected.clear();
  maybeMoveToFoot(mySeat);
  if (!player.opened) {
    state.message = `${seatNames[mySeat]} melded ${cards.length} cards. Opening total is ${openingTotal(player.melds)}/${rule().open}; meld another set before discarding.`;
  } else {
    state.message = `${seatNames[mySeat]} melded ${cards.length} cards.`;
  }
  maybeFinishAfterPlay(mySeat, false);
  broadcast();
}

function discardSelected() {
  if (!isMyTurn() || state.turnStage !== "play") return;
  const cards = selectedCards();
  if (cards.length !== 1) {
    state.message = "Select exactly one card to discard.";
    render();
    return;
  }
  if (!state.players[mySeat].opened && state.players[mySeat].melds.length > 0) {
    state.message = `Opening total is ${openingTotal(state.players[mySeat].melds)}/${rule().open}. Meld another set before discarding.`;
    render();
    return;
  }
  if (state.round === 4 && activeCards(mySeat).length === 1 && canGoOut(mySeat).ok) {
    state.message = "Round 4 requires playing your final card. You cannot discard to go out.";
    render();
    return;
  }
  const card = cards[0];
  setActiveCards(mySeat, activeCards(mySeat).filter((item) => item.id !== card.id));
  state.discard.unshift(card);
  selected.clear();
  if (maybeMoveToFoot(mySeat)) {
    state.turnStage = "play";
    state.message = `${seatNames[mySeat]} moved into the Foot.`;
  } else if (activeCards(mySeat).length === 0 && canGoOut(mySeat).ok) {
    finishRound(mySeat);
  } else {
    endTurn();
  }
  broadcast();
}

function maybeMoveToFoot(seat) {
  const player = state.players[seat];
  if (player.active === "hand" && player.hand.length === 0) {
    player.active = "foot";
    return true;
  }
  return false;
}

function maybeFinishAfterPlay(seat, discarded) {
  if (activeCards(seat).length === 0 && canGoOut(seat).ok && (state.round !== 4 || !discarded)) {
    finishRound(seat);
  }
}

function endTurn() {
  state.currentTurn = nextSeat(state.currentTurn);
  state.turnStage = "draw";
  state.message = `${seatNames[state.currentTurn]} to draw.`;
}

function finishRound(winner) {
  state.wentOut = winner;
  seats.forEach((seat) => {
    state.scores[seat] += scoreSeat(seat, winner);
  });
  state.turnStage = "complete";
  state.message = `${seatNames[winner]} went out. Round scored.`;
}

function scoreSeat(seat, winner) {
  const player = state.players[seat];
  let total = 0;
  player.melds.forEach((meld) => {
    total += meld.cards.reduce((sum, card) => sum + cardValue(card), 0);
    const book = bookType(meld);
    if (book === "clean") total += 500;
    if (book === "dirty") total += 300;
    if (book === "black3") total += 1000;
  });
  const unplayed = [...player.hand, ...player.foot];
  total -= unplayed.reduce((sum, card) => sum + cardValue(card), 0);
  if (seat !== winner) total -= unplayed.filter(isRedThree).length * 500;
  if (seat === winner) total += 100;
  return total;
}

function validateNewMeld(cards, player) {
  if (cards.length < 3) return { ok: false, reason: "A new meld needs at least 3 cards." };
  const naturals = cards.filter((card) => !isWild(card));
  if (!naturals.length) return { ok: false, reason: "A meld needs natural cards." };
  const rank = naturals[0].rank;
  if (naturals.some((card) => card.rank !== rank)) return { ok: false, reason: "Natural cards in a meld must match." };
  if (isRedThree(naturals[0])) return { ok: false, reason: "Red 3s cannot be melded." };
  if (rank === "3" && naturals.some((card) => card.suit === "H" || card.suit === "D")) return { ok: false, reason: "Only black 3s can make a book." };
  if (rank === "3" && cards.some(isWild)) return { ok: false, reason: "Black 3 book must be clean." };
  if (cards.length > 7) return { ok: false, reason: "A book tops out at 7 cards." };
  if (player.melds.some((meld) => meld.rank === rank)) return { ok: false, reason: "Add to your existing meld for that rank." };
  if (!dirtyRatioOk(cards)) return { ok: false, reason: "Naturals must outnumber wild cards." };
  return { ok: true, rank };
}

function validateAddMeld(cards, meld) {
  if (!meld) return { ok: false, reason: "Choose a meld first." };
  if (meld.cards.length >= 7) return { ok: false, reason: "That book is already complete." };
  if (meld.cards.length + cards.length > 7) return { ok: false, reason: "A book can only have 7 cards." };
  const bad = cards.some((card) => !isWild(card) && card.rank !== meld.rank);
  if (bad) return { ok: false, reason: "Cards must match the meld rank." };
  if (meld.rank === "3" && cards.some((card) => isWild(card) || isRedThree(card))) return { ok: false, reason: "Black 3 books use only black 3s." };
  if (!dirtyRatioOk([...meld.cards, ...cards])) return { ok: false, reason: "Naturals must outnumber wild cards." };
  return { ok: true, rank: meld.rank };
}

function dirtyRatioOk(cards) {
  const wilds = cards.filter(isWild).length;
  const naturals = cards.length - wilds;
  return wilds === 0 || naturals > wilds;
}

function canGoOut(seat) {
  const player = state.players[seat];
  const books = player.melds.map(bookType);
  const clean = books.filter((type) => type === "clean" || type === "black3").length;
  const dirty = books.filter((type) => type === "dirty").length;
  if (clean < rule().books || dirty < rule().books) return { ok: false };
  if (player.active !== "foot") return { ok: false };
  return { ok: true };
}

function bookType(meld) {
  if (meld.cards.length < 7) return "open";
  if (meld.rank === "3") return "black3";
  return meld.cards.some(isWild) ? "dirty" : "clean";
}

function openingTotal(melds) {
  return melds.flatMap((meld) => meld.cards).reduce((sum, card) => sum + cardValue(card), 0);
}

function selectedCards() {
  return activeCards(mySeat).filter((card) => selected.has(card.id));
}

function cardValue(card) {
  if (card.rank === "X") return 50;
  if (card.rank === "2" || card.rank === "A") return 20;
  if (["K", "Q", "J", "T", "9", "8"].includes(card.rank)) return 10;
  if (["7", "6", "5", "4"].includes(card.rank)) return 5;
  if (card.rank === "3") return isRedThree(card) ? 0 : 5;
  return 0;
}

function isWild(card) {
  return card.rank === "2" || card.rank === "X";
}

function isRedThree(card) {
  return card.rank === "3" && (card.suit === "H" || card.suit === "D");
}

function nextSeat(seat) {
  return seat === "south" ? "north" : "south";
}

function isMyTurn() {
  return mySeat && state.currentTurn === mySeat && !state.wentOut;
}

function render() {
  els.hostBtn.disabled = Boolean(role);
  els.joinBtn.disabled = Boolean(role);
  els.copyBtn.disabled = !els.roomInput.value.trim();
  els.roomStatus.textContent = els.roomInput.value.trim().toUpperCase() || "-";
  els.seatStatus.textContent = mySeat ? seatNames[mySeat] : "Choose Host or Join";
  els.southScore.textContent = state.scores.south;
  els.northScore.textContent = state.scores.north;
  els.roundStatus.textContent = `${state.round} · draw ${rule().draw}`;
  els.stockCount.textContent = state.stock.length;
  els.discardTop.innerHTML = state.discard[0] ? cardMarkup(state.discard[0]) : "-";
  els.discardTop.className = state.discard[0] ? cardSuitClass(state.discard[0]) : "";
  els.discardCount.textContent = `${state.discard.length} cards`;
  els.gameMessage.textContent = state.message;
  els.turnStatus.textContent = state.wentOut ? "Round complete" : `${seatNames[state.currentTurn]} ${turnStageLabel()}`;
  els.handLabel.textContent = mySeat ? `Your ${state.players[mySeat].active}` : "Your cards";
  renderSeats();
  renderMelds("south", els.southMelds);
  renderMelds("north", els.northMelds);
  renderHand();
  renderActions();
}

function renderSeats() {
  seats.forEach((seat) => {
    const player = state.players[seat];
    const books = player.melds.map(bookType);
    const clean = books.filter((type) => type === "clean" || type === "black3").length;
    const dirty = books.filter((type) => type === "dirty").length;
    const el = seat === "south" ? els.seatSouth : els.seatNorth;
    el.classList.toggle("active-seat", state.currentTurn === seat && !state.wentOut);
    el.innerHTML = `
      <div class="player-name">${seatNames[seat]}${seat === mySeat ? " (you)" : ""}</div>
      <div class="player-meta">Hand ${player.hand.length} · Foot ${player.foot.length} · active ${player.active}</div>
      <div class="player-meta">Open ${player.opened ? "yes" : openingTotal(player.melds) + "/" + rule().open}</div>
      <div class="player-meta">Books ${clean}/${rule().books} clean · ${dirty}/${rule().books} dirty</div>
    `;
  });
}

function renderMelds(seat, container) {
  container.innerHTML = "";
  state.players[seat].melds.forEach((meld, index) => {
    const item = document.createElement("div");
    item.className = "meld";
    const type = bookType(meld);
    item.innerHTML = `
      <div class="meld-title"><span>${rankName(meld.rank)}</span><span>${meld.cards.length}/7</span></div>
      <div class="meld-meta">${type} · ${meld.cards.filter(isWild).length} wild</div>
      <div class="meld-meta">${meld.cards.map(cardLabel).join(" ")}</div>
    `;
    if (seat === mySeat && isMyTurn() && state.turnStage === "play") {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Add selected";
      button.addEventListener("click", () => meldSelected(index));
      item.append(button);
    }
    container.append(item);
  });
}

function renderHand() {
  els.hand.innerHTML = "";
  if (!mySeat) return;
  sortCards(activeCards(mySeat)).forEach((card) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `card ${cardSuitClass(card)} ${isWild(card) ? "wild" : ""} ${isRedThree(card) ? "red-three" : ""} ${selected.has(card.id) ? "selected" : ""}`;
    button.innerHTML = cardMarkup(card);
    button.addEventListener("click", () => {
      if (selected.has(card.id)) selected.delete(card.id);
      else selected.add(card.id);
      render();
    });
    els.hand.append(button);
  });
}

function renderActions() {
  els.actionControls.innerHTML = "";
  if (!mySeat || state.wentOut) return;
  if (isMyTurn() && state.turnStage === "firstDiscard") {
    addAction("Take first discard", takeFirstDiscard);
    addAction("Skip first discard", skipFirstDiscard);
  }
  if (isMyTurn() && state.turnStage === "draw") {
    addAction("Draw stock", takeStock);
    const check = canTakeDiscard(mySeat);
    addAction(check.ok ? "Pick discard" : check.reason, takeDiscard, !check.ok);
  }
  if (isMyTurn() && state.turnStage === "play") {
    addAction("New meld", () => meldSelected(null));
    addAction("Discard selected", discardSelected);
  }
}

function turnStageLabel() {
  if (state.turnStage === "firstDiscard") return "first discard";
  return state.turnStage;
}

function addAction(label, fn, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", fn);
  els.actionControls.append(button);
}

function sortCards(cards) {
  return [...cards].sort((a, b) => rankOrder[a.rank] - rankOrder[b.rank] || a.suit.localeCompare(b.suit));
}

function cardLabel(card) {
  return `${card.rank}${suitSymbols[card.suit]}`;
}

function rankName(rank) {
  if (rank === "X") return "Jokers";
  if (rank === "T") return "10s";
  return `${rank}s`;
}

function cardSuitClass(card) {
  if (card.rank === "X") return "suit-j black";
  const red = card.suit === "H" || card.suit === "D";
  return `suit-${card.suit.toLowerCase()} ${red ? "red" : "black"}`;
}

function cardMarkup(card) {
  return `<span class="rank">${card.rank}</span><span class="suit">${suitSymbols[card.suit]}</span>`;
}

els.hostBtn.addEventListener("click", hostRoom);
els.joinBtn.addEventListener("click", joinRoom);
els.stockBtn.addEventListener("click", takeStock);
els.discardBtn.addEventListener("click", takeDiscard);
els.newRoundBtn.addEventListener("click", () => {
  state = createGame(state);
  selected.clear();
  broadcast();
});
els.newGameBtn.addEventListener("click", () => {
  state = createGame();
  selected.clear();
  broadcast();
});
els.copyBtn.addEventListener("click", async () => {
  const code = els.roomInput.value.trim().toUpperCase();
  if (!code) return;
  await navigator.clipboard?.writeText(code);
  els.copyBtn.textContent = "Copied";
  setTimeout(() => {
    els.copyBtn.textContent = "Copy code";
  }, 1200);
});
els.roomInput.addEventListener("input", () => {
  els.roomInput.value = els.roomInput.value.toUpperCase();
  render();
});

render();
fetch("/api/health", { cache: "no-store" })
  .then((response) => {
    if (response.ok) {
      syncMode = "server";
      setConnection("Remote relay ready");
    } else {
      syncMode = "peer";
      setConnection("Browser relay ready");
    }
  })
  .catch(() => {
    syncMode = "peer";
    setConnection("Browser relay ready");
  });
