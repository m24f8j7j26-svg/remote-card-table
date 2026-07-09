const seats = ["south", "north"];
const suitSymbols = { S: "♠", H: "♥", D: "♦", C: "♣" };
const suitOrder = { C: 0, D: 1, H: 2, S: 3 };
const rankOrder = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const seatNames = { north: "North", south: "South" };
const humanSeats = { host: "south", guest: "north" };

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
  handNumber: document.querySelector("#handNumber"),
  trickArea: document.querySelector("#trickArea"),
  gameMessage: document.querySelector("#gameMessage"),
  actionControls: document.querySelector("#bidControls"),
  newHandBtn: document.querySelector("#newHandBtn"),
  hand: document.querySelector("#hand"),
  turnStatus: document.querySelector("#turnStatus"),
  seats: {
    north: document.querySelector("#seatNorth"),
    south: document.querySelector("#seatSouth"),
  },
};

let role = null;
let mySeat = null;
let state = createGame();
let syncMode = "peer";
let pollTimer = null;

function createDeck() {
  return Object.keys(suitSymbols).flatMap((suit) =>
    Object.keys(rankOrder).map((rank) => ({ suit, rank, id: `${rank}${suit}` }))
  );
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
  const handNumber = previous ? previous.handNumber + 1 : 1;
  return {
    handNumber,
    scores: previous ? previous.scores : { south: 0, north: 0 },
    bags: previous ? previous.bags : { south: 0, north: 0 },
    deck: shuffle(createDeck()),
    hands: { south: [], north: [] },
    discards: [],
    bids: { south: null, north: null },
    taken: { south: 0, north: 0 },
    currentTurn: "south",
    phase: "draft",
    trick: [],
    spadesBroken: false,
    lastDraft: null,
    message: "South drafts first. Look at the card, then keep it or discard it.",
  };
}

function compareCards(a, b) {
  if (suitOrder[a.suit] !== suitOrder[b.suit]) return suitOrder[a.suit] - suitOrder[b.suit];
  return rankOrder[a.rank] - rankOrder[b.rank];
}

function hostRoom() {
  if (syncMode === "server") {
    hostServerRoom();
    return;
  }
  setConnection("Remote relay is not available.");
}

function joinRoom() {
  if (syncMode === "server") {
    joinServerRoom();
    return;
  }
  setConnection("Remote relay is not available.");
}

async function hostServerRoom() {
  role = "host";
  mySeat = humanSeats.host;
  setConnection("Creating room...");
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (!response.ok) throw new Error("Could not create room");
    const payload = await response.json();
    els.roomInput.value = payload.room;
    setConnection("Room ready");
    startStatePolling(payload.room);
    render();
  } catch (error) {
    setConnection("Local relay unavailable");
    state.message = "The remote relay is not responding. Try again in a moment.";
    render();
  }
}

async function joinServerRoom() {
  const room = els.roomInput.value.trim().toUpperCase();
  if (!room) {
    setConnection("Enter a room code");
    return;
  }
  role = "guest";
  mySeat = humanSeats.guest;
  setConnection("Connecting...");
  render();
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/state`);
    if (!response.ok) throw new Error("Room not found");
    const payload = await response.json();
    state = payload.state;
    setConnection("Connected");
    startStatePolling(room);
    render();
  } catch (error) {
    setConnection("Room not found");
    state.message = "Ask the host for the newest room code, then try Join again.";
    role = null;
    mySeat = null;
    render();
  }
}

function setConnection(text) {
  els.connectionStatus.textContent = text;
}

function submitAction(action) {
  applyAction(action);
}

function applyAction(action) {
  if (action.kind === "draft") draftCard(action.seat, action.choice);
  if (action.kind === "bid") placeBid(action.seat, action.bid);
  if (action.kind === "play") playCard(action.seat, action.cardId);
  if (action.kind === "newHand") {
    state = createGame(state);
  }
  broadcastState();
}

function broadcastState() {
  if (role && syncMode === "server") {
    putServerState();
  }
  render();
}

async function putServerState() {
  const room = els.roomInput.value.trim().toUpperCase();
  if (!room) return;
  await fetch(`/api/rooms/${encodeURIComponent(room)}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  }).catch(() => {
    setConnection("Relay update failed");
  });
}

function startStatePolling(room) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!room) return;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/state`);
      if (!response.ok) return;
      const payload = await response.json();
      state = payload.state;
      render();
    } catch (error) {
      setConnection("Relay polling failed");
    }
  }, 650);
}

function draftCard(seat, choice) {
  if (state.phase !== "draft" || state.currentTurn !== seat || state.deck.length < 2) return;
  const first = state.deck.shift();
  const second = state.deck.shift();
  const kept = choice === "keep" ? first : second;
  const discarded = choice === "keep" ? second : first;
  state.hands[seat].push(kept);
  state.discards.push(discarded);
  state.lastDraft = { seat, choice, kept, discarded };

  if (state.deck.length === 0) {
    seats.forEach((s) => state.hands[s].sort(compareCards));
    state.phase = "bidding";
    state.currentTurn = "south";
    state.message = "Draft complete. South bids first.";
    return;
  }

  state.currentTurn = nextSeat(seat);
  state.message = `${seatNames[state.currentTurn]} drafts next.`;
}

function placeBid(seat, bid) {
  if (state.phase !== "bidding" || state.currentTurn !== seat || state.bids[seat] !== null) return;
  state.bids[seat] = bid;
  const nextHumanNeedsBid = seats.find((s) => state.bids[s] === null);
  if (nextHumanNeedsBid) {
    state.currentTurn = nextHumanNeedsBid;
    state.message = `${seatNames[nextHumanNeedsBid]} needs to bid.`;
  } else {
    state.phase = "playing";
    state.currentTurn = "south";
    state.message = "Bidding complete. South leads the first trick.";
  }
}

function playCard(seat, cardId) {
  if (state.phase !== "playing" || state.currentTurn !== seat) return;
  const hand = state.hands[seat];
  const card = hand.find((item) => item.id === cardId);
  if (!card || !isLegalPlay(seat, card)) return;
  state.hands[seat] = hand.filter((item) => item.id !== cardId);
  state.trick.push({ seat, card });
  if (card.suit === "S") state.spadesBroken = true;
  if (state.trick.length === 2) {
    finishTrick();
  } else {
    state.currentTurn = nextSeat(seat);
    state.message = `${seatNames[state.currentTurn]} to play.`;
  }
}

function finishTrick() {
  const winner = trickWinner(state.trick);
  state.taken[winner] += 1;
  state.currentTurn = winner;
  state.message = `${seatNames[winner]} takes the trick.`;
  state.trick = [];
  if (seats.every((seat) => state.hands[seat].length === 0)) finishHand();
}

function finishHand() {
  seats.forEach((seat) => {
    const result = scorePlayer(state.bids[seat], state.taken[seat], state.bags[seat]);
    state.scores[seat] += result.score;
    state.bags[seat] = result.bags;
  });
  state.phase = "complete";
  state.message = `Hand complete. South took ${state.taken.south}; North took ${state.taken.north}.`;
}

function scorePlayer(bid, taken, currentBags) {
  if (taken < bid) return { score: -10 * bid, bags: currentBags };
  const overtricks = taken - bid;
  const totalBags = currentBags + overtricks;
  const penalties = Math.floor(totalBags / 5);
  return {
    score: 10 * bid + overtricks - penalties * 50,
    bags: totalBags % 5,
  };
}

function trickWinner(trick) {
  const leadSuit = trick[0].card.suit;
  return trick.reduce((best, play) => {
    const card = play.card;
    const bestCard = best.card;
    const cardIsSpade = card.suit === "S";
    const bestIsSpade = bestCard.suit === "S";
    if (cardIsSpade && !bestIsSpade) return play;
    if (card.suit === bestCard.suit && rankOrder[card.rank] > rankOrder[bestCard.rank]) return play;
    if (!bestIsSpade && card.suit === leadSuit && bestCard.suit !== leadSuit) return play;
    return best;
  }, trick[0]).seat;
}

function nextSeat(seat) {
  return seat === "south" ? "north" : "south";
}

function isLegalPlay(seat, card) {
  const hand = state.hands[seat];
  if (!state.trick.length) {
    if (card.suit !== "S") return true;
    return state.spadesBroken || hand.every((item) => item.suit === "S");
  }
  const leadSuit = state.trick[0].card.suit;
  const hasLead = hand.some((item) => item.suit === leadSuit);
  return !hasLead || card.suit === leadSuit;
}

function legalCards(seat) {
  if (state.phase !== "playing") return [];
  return state.hands[seat].filter((card) => isLegalPlay(seat, card));
}

function render() {
  els.hostBtn.disabled = Boolean(role);
  els.joinBtn.disabled = Boolean(role);
  els.copyBtn.disabled = !els.roomInput.value.trim();
  els.roomStatus.textContent = els.roomInput.value.trim().toUpperCase() || "-";
  els.seatStatus.textContent = mySeat ? seatNames[mySeat] : "Choose Host or Join";
  els.southScore.textContent = state.scores.south;
  els.northScore.textContent = state.scores.north;
  els.handNumber.textContent = state.handNumber;
  els.gameMessage.textContent = messageForViewer();
  els.turnStatus.textContent = turnLabel();
  renderSeats();
  renderControls();
  renderTrick();
  renderHand();
}

function messageForViewer() {
  if (state.phase === "draft" && mySeat === state.currentTurn && currentDraftCard()) {
    return `Your draft card is ${cardLabel(currentDraftCard())}. Keep it or discard it.`;
  }
  if (state.phase === "draft" && state.lastDraft) {
    const verb = state.lastDraft.choice === "keep" ? "kept the first card" : "discarded the first card";
    return `${seatNames[state.lastDraft.seat]} ${verb}. ${cardLabel(state.lastDraft.discarded)} went to the discard pile.`;
  }
  return state.message;
}

function turnLabel() {
  if (state.phase === "draft") return `${seatNames[state.currentTurn]} draft`;
  if (state.phase === "playing") return `${seatNames[state.currentTurn]} turn`;
  return state.phase;
}

function currentDraftCard() {
  return state.deck[0] || null;
}

function renderSeats() {
  seats.forEach((seat) => {
    const bid = state.bids[seat] ?? "-";
    els.seats[seat].classList.toggle("active-seat", state.currentTurn === seat && state.phase !== "complete");
    els.seats[seat].innerHTML = `
      <div class="player-name">${seatNames[seat]}${seat === mySeat ? " (you)" : ""}</div>
      <div class="player-meta">${state.hands[seat].length} cards · ${state.discards.length} discarded</div>
      <div class="player-meta">Bid ${bid} · Took ${state.taken[seat]} · Bags ${state.bags[seat]}</div>
    `;
  });
}

function renderControls() {
  els.actionControls.innerHTML = "";
  if (!mySeat) return;
  if (state.phase === "draft" && state.currentTurn === mySeat && currentDraftCard()) {
    const preview = document.createElement("div");
    preview.className = `draft-card ${cardSuitClass(currentDraftCard())}`;
    preview.innerHTML = cardMarkup(currentDraftCard());
    els.actionControls.append(preview);
    ["keep", "discard"].forEach((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice === "keep" ? "Keep" : "Discard";
      button.addEventListener("click", () => submitAction({ kind: "draft", seat: mySeat, choice }));
      els.actionControls.append(button);
    });
  }
  if (state.phase === "bidding" && state.currentTurn === mySeat && state.bids[mySeat] === null) {
    for (let bid = 0; bid <= 13; bid += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = bid;
      button.addEventListener("click", () => submitAction({ kind: "bid", seat: mySeat, bid }));
      els.actionControls.append(button);
    }
  }
}

function renderTrick() {
  els.trickArea.innerHTML = "";
  state.trick.forEach((play) => {
    const card = document.createElement("div");
    card.className = `played-card played-${play.seat} ${cardSuitClass(play.card)}`;
    card.innerHTML = cardMarkup(play.card);
    els.trickArea.append(card);
  });
}

function renderHand() {
  els.hand.innerHTML = "";
  if (!mySeat) return;
  const legal = new Set(legalCards(mySeat).map((card) => card.id));
  state.hands[mySeat].forEach((card) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `card ${cardSuitClass(card)} ${legal.has(card.id) ? "legal" : ""}`;
    button.innerHTML = cardMarkup(card);
    button.disabled = state.phase !== "playing" || state.currentTurn !== mySeat || !legal.has(card.id);
    button.addEventListener("click", () => submitAction({ kind: "play", seat: mySeat, cardId: card.id }));
    els.hand.append(button);
  });
}

function isRed(card) {
  return card.suit === "H" || card.suit === "D";
}

function cardSuitClass(card) {
  return `suit-${card.suit.toLowerCase()} ${isRed(card) ? "red" : "black"}`;
}

function cardLabel(card) {
  return `${card.rank}${suitSymbols[card.suit]}`;
}

function cardMarkup(card) {
  return `<span class="rank">${card.rank}</span><span class="suit">${suitSymbols[card.suit]}</span>`;
}

els.hostBtn.addEventListener("click", hostRoom);
els.joinBtn.addEventListener("click", joinRoom);
els.copyBtn.addEventListener("click", async () => {
  const code = els.roomInput.value.trim().toUpperCase();
  if (!code) return;
  await navigator.clipboard?.writeText(code);
  els.copyBtn.textContent = "Copied";
  setTimeout(() => {
    els.copyBtn.textContent = "Copy code";
  }, 1200);
});
els.newHandBtn.addEventListener("click", () => submitAction({ kind: "newHand" }));
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
    }
  })
  .catch(() => {
    syncMode = "peer";
  });
