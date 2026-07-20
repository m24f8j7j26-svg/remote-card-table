const seats = ["south", "north"];
const suitSymbols = { S: "♠", H: "♥", D: "♦", C: "♣" };
const suitOrder = { C: 0, D: 1, H: 2, S: 3 };
const rankOrder = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const seatNames = { north: "North", south: "South" };
const humanSeats = { host: "south", guest: "north" };
const nilBonus = 100;
const nilPenalty = -100;
const localSessionKey = "remote-card-table-spades-session-v1";
const remoteRelayOrigin = "https://cards.boyzofsummerpics.com";
const apiBaseUrl =
  typeof location !== "undefined" && location.hostname.endsWith("github.io") ? remoteRelayOrigin : "";

const els = {
  hostBtn: document.querySelector("#hostBtn"),
  copyBtn: document.querySelector("#copyBtn"),
  clearRoomBtn: document.querySelector("#clearRoomBtn"),
  joinBtn: document.querySelector("#joinBtn"),
  roomInput: document.querySelector("#roomInput"),
  connectionStatus: document.querySelector("#connectionStatus"),
  seatStatus: document.querySelector("#seatStatus"),
  roomStatus: document.querySelector("#roomStatus"),
  southScore: document.querySelector("#southScore"),
  northScore: document.querySelector("#northScore"),
  handNumber: document.querySelector("#handNumber"),
  trickArea: document.querySelector("#trickArea"),
  table: document.querySelector(".table"),
  gameMessage: document.querySelector("#gameMessage"),
  actionControls: document.querySelector("#bidControls"),
  newHandBtn: document.querySelector("#newHandBtn"),
  newGameBtn: document.querySelector("#newGameBtn"),
  hand: document.querySelector("#hand"),
  turnStatus: document.querySelector("#turnStatus"),
  seats: {
    north: document.querySelector("#seatNorth"),
    south: document.querySelector("#seatSouth"),
  },
};

const savedSession = loadLocalSession();
let role = null;
let mySeat = null;
let state = normalizeState(savedSession?.state);
let syncMode = apiBaseUrl ? "server" : "peer";
let pollTimer = null;
let presenceTimer = null;
let presence = {};
let connectionText = "Not connected";
let pollFailures = 0;
let serverWriteInFlight = false;
let queuedServerState = null;
let serverRetryTimer = null;
let peer = null;
let peerConn = null;

if (savedSession?.room) {
  els.roomInput.value = savedSession.room;
  connectionText = "Saved room found";
}

function apiUrl(path) {
  return `${apiBaseUrl}${path}`;
}

function stateRevision(game = state) {
  return Number.isFinite(game?.revision) ? game.revision : 0;
}

function normalizeState(game) {
  if (!game) return createGame();
  if (!game.game) game.game = "spades";
  if (!Number.isFinite(game.revision)) game.revision = 0;
  return game;
}

function bumpStateRevision() {
  state.revision = stateRevision() + 1;
}

function shouldAcceptRemoteState(remoteState) {
  return stateRevision(remoteState) > stateRevision();
}

function currentRoomCode() {
  return els.roomInput.value.trim().toUpperCase();
}

function roleForSeat(seat) {
  return seat === humanSeats.host ? "host" : "guest";
}

function cloneState(game) {
  return JSON.parse(JSON.stringify(game));
}

function newerState(a, b) {
  if (!a) return b;
  if (!b) return a;
  return stateRevision(a) >= stateRevision(b) ? a : b;
}

function loadLocalSession() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(localSessionKey);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session?.state && seats.includes(session.seat) && typeof session.room === "string") return session;
  } catch (error) {
    clearLocalSession();
  }
  return null;
}

function saveLocalSession() {
  try {
    if (typeof localStorage === "undefined") return;
    const room = currentRoomCode();
    if (!room || !mySeat) return;
    localStorage.setItem(localSessionKey, JSON.stringify({
      state,
      room,
      seat: mySeat,
      role: role || roleForSeat(mySeat),
      updatedAt: Date.now(),
    }));
  } catch (error) {
    // Private browsing can block local storage; remote play still works without refresh restore.
  }
}

function clearLocalSession() {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(localSessionKey);
  } catch (error) {
    // Ignore storage cleanup failures.
  }
}

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

function startingSeat(previous = null) {
  if (!previous) return seats[Math.floor(Math.random() * seats.length)];
  return nextSeat(previous.firstSeat || (previous.handNumber % 2 === 0 ? "north" : "south"));
}

function createGame(previous = null) {
  const handNumber = previous ? previous.handNumber + 1 : 1;
  const firstSeat = startingSeat(previous);
  return {
    game: "spades",
    revision: previous ? stateRevision(previous) : 0,
    firstSeat,
    handNumber,
    scores: previous ? previous.scores : { south: 0, north: 0 },
    bags: previous ? previous.bags : { south: 0, north: 0 },
    deck: shuffle(createDeck()),
    hands: { south: [], north: [] },
    discards: [],
    bids: { south: null, north: null },
    taken: { south: 0, north: 0 },
    currentTurn: firstSeat,
    phase: "draft",
    trick: [],
    spadesBroken: false,
    lastDraft: null,
    lastTrick: null,
    message: `${seatNames[firstSeat]} drafts first. Look at the card, then keep it or discard it.`,
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
  hostPeerRoom();
}

function joinRoom() {
  if (syncMode === "server") {
    joinServerRoom();
    return;
  }
  joinPeerRoom();
}

function makeRoomCode(prefix) {
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function peerOptions() {
  return {
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
      ],
    },
  };
}

function peerErrorText(error) {
  const type = error?.type || "unknown";
  if (type === "unavailable-id") return "Room collision. Clear code and host again.";
  if (type === "peer-unavailable") return "Room not found. Check the code and make sure host stays open.";
  if (type === "network") return "Peer network blocked. Try Wi-Fi, or use the hosted relay version.";
  if (type === "server-error") return "Peer relay server error. Try again in a minute.";
  return `Peer relay error: ${type}`;
}

function hostPeerRoom() {
  role = "host";
  mySeat = humanSeats.host;
  const code = makeRoomCode("SPADES");
  setConnection("Creating room...");
  peer = new Peer(code, peerOptions());
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
    setConnection(peerErrorText(error));
    role = null;
    mySeat = null;
    render();
  });
}

function joinPeerRoom() {
  const room = els.roomInput.value.trim().toUpperCase();
  if (!room) {
    setConnection("Enter a room code");
    return;
  }
  role = "guest";
  mySeat = humanSeats.guest;
  setConnection("Connecting...");
  peer = new Peer(undefined, peerOptions());
  peer.on("open", () => {
    peerConn = peer.connect(room, { reliable: true });
    wireGuestPeerConnection(peerConn);
  });
  peer.on("error", (error) => {
    setConnection(peerErrorText(error));
    role = null;
    mySeat = null;
    render();
  });
  render();
}

function wireHostPeerConnection(conn) {
  conn.on("open", () => {
    setConnection("Connected");
    sendPeerState(conn);
    [300, 900, 1800].forEach((delay) => setTimeout(() => sendPeerState(conn), delay));
  });
  conn.on("data", (message) => {
    if (message.type === "requestState") sendPeerState(conn);
    if (message.type === "action") applyAction(message.action);
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
      state = normalizeState(message.state);
      saveLocalSession();
      render();
    }
  });
  conn.on("close", () => setConnection("Host disconnected. Ask host to keep the room page open."));
}

function sendPeerState(conn = peerConn) {
  if (conn?.open) conn.send({ type: "state", state });
}

async function hostServerRoom() {
  role = "host";
  mySeat = humanSeats.host;
  setConnection("Creating room...");
  try {
    const response = await fetch(apiUrl("/api/rooms"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (!response.ok) throw new Error("Could not create room");
    const payload = await response.json();
    els.roomInput.value = payload.room;
    setConnection("Room ready");
    startStatePolling(payload.room);
    startPresence(payload.room);
    saveLocalSession();
    render();
  } catch (error) {
    setConnection("Local relay unavailable");
    state.message = "The remote relay is not responding. Try again in a moment.";
    render();
  }
}

async function joinServerRoom() {
  const room = currentRoomCode();
  if (!room) {
    setConnection("Enter a room code");
    return;
  }
  await connectServerRoom(room, humanSeats.guest, "Connected", "Ask the host for the newest room code, then try Join again.");
}

async function reconnectSavedServerRoom() {
  if (!savedSession?.room || !seats.includes(savedSession.seat)) return false;
  return connectServerRoom(
    savedSession.room,
    savedSession.seat,
    "Reconnected",
    "The saved room is no longer available. Host a new room or ask for a fresh room code.",
    true
  );
}

async function connectServerRoom(room, seat, connectedText, missingMessage, restoring = false) {
  role = roleForSeat(seat);
  mySeat = seat;
  els.roomInput.value = room;
  setConnection(restoring ? "Reconnecting..." : "Connecting...");
  render();
  try {
    const response = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(room)}/state`));
    if (!response.ok) throw new Error("Room not found");
    const payload = await response.json();
    const remoteState = normalizeState(payload.state);
    const savedState = normalizeState(savedSession?.state);
    state = restoring && stateRevision(savedState) > stateRevision(remoteState) ? savedState : remoteState;
    presence = payload.presence || {};
    setConnection(connectedText);
    startStatePolling(room);
    startPresence(room);
    saveLocalSession();
    if (stateRevision(state) > stateRevision(remoteState)) putServerState();
    render();
    return true;
  } catch (error) {
    setConnection("Room not found");
    state.message = missingMessage;
    role = null;
    mySeat = null;
    if (restoring) clearLocalSession();
    render();
    return false;
  }
}

function setConnection(text) {
  connectionText = text;
  renderConnection();
}

function renderConnection() {
  els.connectionStatus.textContent = `${connectionText}${partnerPresenceText()}`;
}

function partnerPresenceText() {
  if (syncMode !== "server" || !role || !mySeat) return "";
  const seat = mySeat === "south" ? "north" : "south";
  const partner = presence[seat];
  if (partner?.online) return ` • ${seatNames[seat]} online`;
  if (typeof partner?.lastSeenAgoMs === "number") return ` • ${seatNames[seat]} last seen ${formatAgo(partner.lastSeenAgoMs)}`;
  return ` • waiting for ${seatNames[seat]}`;
}

function formatAgo(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

function clearRoomCode() {
  clearInterval(pollTimer);
  clearInterval(presenceTimer);
  pollTimer = null;
  presenceTimer = null;
  presence = {};
  pollFailures = 0;
  queuedServerState = null;
  clearTimeout(serverRetryTimer);
  serverRetryTimer = null;
  peerConn?.close();
  peer?.destroy();
  peerConn = null;
  peer = null;
  role = null;
  mySeat = null;
  els.roomInput.value = "";
  state = createGame();
  clearLocalSession();
  setConnection(syncMode === "server" ? "Remote relay ready" : "Browser relay ready");
  render();
}

function submitAction(action) {
  if (syncMode === "peer" && role === "guest" && peerConn?.open) {
    peerConn.send({ type: "action", action });
    return;
  }
  applyAction(action);
}

function applyAction(action) {
  let changed = false;
  if (action.kind === "draft") changed = draftCard(action.seat, action.choice);
  if (action.kind === "bid") changed = placeBid(action.seat, action.bid);
  if (action.kind === "play") changed = playCard(action.seat, action.cardId);
  if (action.kind === "nextTrick") changed = clearLastTrick(action.seat);
  if (action.kind === "newHand") {
    state = createGame(state);
    changed = true;
  }
  if (action.kind === "newGame") {
    const previousRevision = stateRevision();
    state = createGame();
    state.revision = previousRevision;
    changed = true;
  }
  if (!changed) {
    render();
    return;
  }
  bumpStateRevision();
  broadcastState();
}

function broadcastState() {
  saveLocalSession();
  if (syncMode === "peer" && role === "host" && peerConn?.open) {
    sendPeerState();
  }
  if (role && syncMode === "server") {
    putServerState();
  }
  render();
}

function putServerState() {
  const room = currentRoomCode();
  if (!room) return;
  queuedServerState = cloneState(state);
  flushQueuedServerState(room);
}

async function flushQueuedServerState(room = currentRoomCode()) {
  if (serverWriteInFlight || !queuedServerState || !room) return;
  clearTimeout(serverRetryTimer);
  serverRetryTimer = null;
  serverWriteInFlight = true;
  const snapshot = queuedServerState;
  queuedServerState = null;
  try {
    const response = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(room)}/state`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: snapshot }),
    });
    if (!response.ok) throw new Error("Relay update failed");
    pollFailures = 0;
    if (connectionText === "Relay retrying") connectionText = role === "host" ? "Room ready" : "Connected";
  } catch (error) {
    queuedServerState = newerState(queuedServerState, snapshot);
    setConnection("Relay retrying");
    serverRetryTimer = setTimeout(() => {
      serverRetryTimer = null;
      flushQueuedServerState(room);
    }, 900);
  } finally {
    serverWriteInFlight = false;
    if (queuedServerState && !serverRetryTimer) flushQueuedServerState(room);
  }
}

function startStatePolling(room) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!room) return;
    try {
      const response = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(room)}/state`));
      if (!response.ok) return;
      const payload = await response.json();
      const remoteState = normalizeState(payload.state);
      pollFailures = 0;
      presence = payload.presence || presence;
      if (syncMode === "server" && role) connectionText = role === "host" ? "Room ready" : "Connected";
      if (!shouldAcceptRemoteState(remoteState)) {
        renderConnection();
        return;
      }
      state = remoteState;
      saveLocalSession();
      render();
    } catch (error) {
      pollFailures += 1;
      if (pollFailures >= 3) setConnection("Relay reconnecting");
    }
  }, 650);
}

function startPresence(room) {
  clearInterval(presenceTimer);
  sendPresence(room);
  presenceTimer = setInterval(() => sendPresence(room), 5000);
}

async function sendPresence(room) {
  if (!room || syncMode !== "server" || !mySeat) return;
  try {
    const response = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(room)}/presence`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: mySeat }),
    });
    if (!response.ok) return;
    const payload = await response.json();
    pollFailures = 0;
    presence = payload.presence || presence;
    if (syncMode === "server" && role && connectionText === "Relay reconnecting") connectionText = role === "host" ? "Room ready" : "Connected";
    renderConnection();
  } catch (error) {
    pollFailures += 1;
    if (pollFailures >= 3) setConnection("Relay reconnecting");
  }
}

function draftCard(seat, choice) {
  if (state.phase !== "draft" || state.currentTurn !== seat || state.deck.length < 2) return false;
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
    state.currentTurn = state.firstSeat || "south";
    state.message = `Draft complete. ${seatNames[state.currentTurn]} bids first.`;
    return true;
  }

  state.currentTurn = nextSeat(seat);
  state.message = `${seatNames[state.currentTurn]} drafts next.`;
  return true;
}

function placeBid(seat, bid) {
  if (state.phase !== "bidding" || state.currentTurn !== seat || state.bids[seat] !== null) return false;
  state.bids[seat] = bid;
  const nextHumanNeedsBid = state.bids[nextSeat(seat)] === null ? nextSeat(seat) : null;
  if (nextHumanNeedsBid) {
    state.currentTurn = nextHumanNeedsBid;
    state.message = `${seatNames[nextHumanNeedsBid]} needs to bid.`;
  } else {
    state.phase = "playing";
    state.currentTurn = state.firstSeat || "south";
    state.message = `Bidding complete. ${seatNames[state.currentTurn]} leads the first trick.`;
  }
  return true;
}

function playCard(seat, cardId) {
  if (state.phase !== "playing" || state.currentTurn !== seat) return false;
  const hand = state.hands[seat];
  const card = hand.find((item) => item.id === cardId);
  if (!card || !isLegalPlay(seat, card)) return false;
  if (state.trick.length === 0 && state.lastTrick?.plays?.length) state.lastTrick = null;
  state.hands[seat] = hand.filter((item) => item.id !== cardId);
  state.trick.push({ seat, card });
  if (card.suit === "S") state.spadesBroken = true;
  if (state.trick.length === 2) {
    finishTrick();
  } else {
    state.currentTurn = nextSeat(seat);
    state.message = `${seatNames[state.currentTurn]} to play.`;
  }
  return true;
}

function clearLastTrick(seat) {
  if (state.phase !== "playing" || state.currentTurn !== seat || state.trick.length || !state.lastTrick?.plays?.length) {
    return false;
  }
  state.lastTrick = null;
  state.message = `${seatNames[state.currentTurn]} leads the next trick.`;
  return true;
}

function finishTrick() {
  const plays = state.trick.map((play) => ({ seat: play.seat, card: play.card }));
  const winning = winningPlay(plays);
  const winner = winning.seat;
  state.lastTrick = { plays, winner, winningCard: winning.card };
  state.taken[winner] += 1;
  state.currentTurn = winner;
  state.message = `${seatNames[winner]} takes the trick with ${cardLabel(winning.card)}. ${seatNames[winner]} leads next. ${trickSummary(plays)}.`;
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
  if (bid === 0) {
    if (taken === 0) return { score: nilBonus, bags: currentBags };
    const totalBags = currentBags + taken;
    const penalties = Math.floor(totalBags / 5);
    return {
      score: nilPenalty - penalties * 50,
      bags: totalBags % 5,
    };
  }
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
  return winningPlay(trick).seat;
}

function winningPlay(trick) {
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
  }, trick[0]);
}

function trickSummary(plays) {
  return plays.map((play) => `${seatNames[play.seat]} played ${cardLabel(play.card)}`).join("; ");
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
  els.roomInput.disabled = Boolean(role);
  els.roomStatus.textContent = els.roomInput.value.trim().toUpperCase() || "-";
  renderConnection();
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
    return `Your draft card is ${cardLabel(currentDraftCard())}. Click the card to keep it, or click the discard pile to discard it.`;
  }
  if (state.phase === "draft" && state.lastDraft) {
    const verb = state.lastDraft.choice === "keep" ? "kept the first card" : "discarded the first card";
    if (state.lastDraft.seat === mySeat) {
      return `${seatNames[state.lastDraft.seat]} ${verb}. Your discard was ${cardLabel(state.lastDraft.discarded)}.`;
    }
    return `${seatNames[state.lastDraft.seat]} ${verb}. The discard is covered.`;
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

function isMyDraftTurn() {
  return state.phase === "draft" && mySeat === state.currentTurn && Boolean(currentDraftCard());
}

function renderSeats() {
  seats.forEach((seat) => {
    const bid = bidLabel(state.bids[seat]);
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
  if (state.phase === "bidding" && state.currentTurn === mySeat && state.bids[mySeat] === null) {
    for (let bid = 0; bid <= 13; bid += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = bidLabel(bid);
      button.addEventListener("click", () => submitAction({ kind: "bid", seat: mySeat, bid }));
      els.actionControls.append(button);
    }
  }
  if (state.phase === "playing" && state.currentTurn === mySeat && state.trick.length === 0 && state.lastTrick?.plays?.length) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Next trick";
    button.addEventListener("click", () => submitAction({ kind: "nextTrick", seat: mySeat }));
    els.actionControls.append(button);
  }
}

function renderTrick() {
  els.trickArea.innerHTML = "";
  if (state.phase === "draft") {
    renderDraftPiles();
    return;
  }
  const showingLastTrick = state.trick.length === 0 && state.lastTrick?.plays?.length;
  const plays = showingLastTrick ? state.lastTrick.plays : state.trick;
  els.table.classList.toggle("has-table-cards", plays.length > 0);
  if (!plays.length) return;
  const playBySeat = Object.fromEntries(plays.map((play) => [play.seat, play]));
  const tableCards = document.createElement("div");
  tableCards.className = `table-cards ${showingLastTrick ? "showing-last-trick" : ""}`;
  ["north", "south"].forEach((seat) => {
    const slot = document.createElement("div");
    const play = playBySeat[seat];
    slot.className = `table-card-slot table-card-${seat}`;
    if (!play) {
      const placeholder = document.createElement("div");
      placeholder.className = "played-card table-card-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      slot.append(placeholder);
      tableCards.append(slot);
      return;
    }
    const card = document.createElement("div");
    const won = showingLastTrick && state.lastTrick.winner === play.seat;
    card.className = `played-card table-played-card played-${play.seat} ${cardSuitClass(play.card)} ${showingLastTrick ? "last-trick-card" : ""} ${won ? "winning-card" : ""}`;
    card.title = showingLastTrick
      ? `Last trick: ${seatNames[state.lastTrick.winner]} won with ${cardLabel(state.lastTrick.winningCard)}`
      : `${seatNames[play.seat]} played ${cardLabel(play.card)}`;
    card.innerHTML = cardMarkup(play.card);
    slot.append(card);
    tableCards.append(slot);
  });
  els.trickArea.append(tableCards);
}

function renderDraftPiles() {
  els.table.classList.add("has-table-cards");
  const piles = document.createElement("div");
  piles.className = "table-piles";
  piles.append(createStockPile(), createDiscardPile());
  els.trickArea.append(piles);
}

function createStockPile() {
  const pile = document.createElement("div");
  pile.className = "table-pile stock-pile";
  pile.title = `${state.deck.length} cards in the stock`;
  if (isMyDraftTurn()) {
    const card = document.createElement("div");
    card.className = `played-card table-pile-card stock-top-card ${cardSuitClass(currentDraftCard())}`;
    wireDraftChoice(pile, "keep", `Keep ${cardLabel(currentDraftCard())}`);
    card.title = `Click to keep ${cardLabel(currentDraftCard())}`;
    card.innerHTML = cardMarkup(currentDraftCard());
    card.append(createPileCount(state.deck.length));
    pile.append(card);
    return pile;
  }
  pile.append(createCardBack("stock-card-back", state.deck.length));
  return pile;
}

function createDiscardPile() {
  const pile = document.createElement("div");
  pile.className = "table-pile discard-pile";
  pile.title = `${state.discards.length} cards in the discard pile`;
  if (isMyDraftTurn()) {
    wireDraftChoice(pile, "discard", `Discard ${cardLabel(currentDraftCard())}`);
  }
  if (!state.discards.length) {
    pile.classList.add("empty-pile");
    const empty = document.createElement("div");
    empty.className = "table-pile-card empty-discard-slot";
    if (isMyDraftTurn()) empty.title = `Click to discard ${cardLabel(currentDraftCard())}`;
    pile.append(empty);
    return pile;
  }

  const canSeeDiscard = state.lastDraft?.seat === mySeat;
  if (canSeeDiscard) {
    const card = document.createElement("div");
    card.className = `played-card table-pile-card discard-pile-card ${cardSuitClass(state.lastDraft.discarded)}`;
    card.title = `Your discard: ${cardLabel(state.lastDraft.discarded)}`;
    card.innerHTML = cardMarkup(state.lastDraft.discarded);
    card.append(createPileCount(state.discards.length));
    pile.append(card);
    return pile;
  }

  pile.append(createCardBack("covered-discard-card", state.discards.length));
  return pile;
}

function createCardBack(extraClass, count) {
  const back = document.createElement("div");
  back.className = `table-pile-card card-back ${extraClass}`;
  back.append(createPileCount(count));
  return back;
}

function createPileCount(count) {
  const badge = document.createElement("span");
  badge.className = "pile-count";
  badge.textContent = count;
  return badge;
}

function wireDraftChoice(element, choice, label) {
  element.classList.add("draft-choice", `${choice}-choice`);
  element.title = label;
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  element.setAttribute("aria-label", label);
  element.addEventListener("click", () => submitAction({ kind: "draft", seat: mySeat, choice }));
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    submitAction({ kind: "draft", seat: mySeat, choice });
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

function bidLabel(bid) {
  if (bid === null || bid === undefined) return "-";
  return bid === 0 ? "Nil" : bid;
}

function cardMarkup(card) {
  return `<span class="rank">${card.rank}</span><span class="suit">${suitSymbols[card.suit]}</span>`;
}

els.hostBtn.addEventListener("click", hostRoom);
els.joinBtn.addEventListener("click", joinRoom);
els.clearRoomBtn.addEventListener("click", clearRoomCode);
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
els.newGameBtn.addEventListener("click", () => submitAction({ kind: "newGame" }));
els.roomInput.addEventListener("input", () => {
  els.roomInput.value = els.roomInput.value.toUpperCase();
  render();
});

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", saveLocalSession);
}

render();

fetch(apiUrl("/api/health"), { cache: "no-store" })
  .then(async (response) => {
    if (response.ok) {
      syncMode = "server";
      setConnection("Remote relay ready");
      await reconnectSavedServerRoom();
    } else {
      syncMode = "peer";
      setConnection("Browser relay ready");
    }
  })
  .catch(() => {
    syncMode = "peer";
    setConnection("Browser relay ready");
  });
