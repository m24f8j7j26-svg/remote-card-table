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
const startingHandSize = 11;
const startingFootSize = 11;
const cardsPerDeck = 13 * 4 + 2;
const deckCount = 6;
const previousDeckCounts = [4];
const localSessionKey = "remote-card-table-handfoot-session-v1";
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
  roundStatus: document.querySelector("#roundStatus"),
  seatNorth: document.querySelector("#seatNorth"),
  seatSouth: document.querySelector("#seatSouth"),
  stockBtn: document.querySelector("#stockBtn"),
  discardBtn: document.querySelector("#discardBtn"),
  stockCount: document.querySelector("#stockCount"),
  discardTop: document.querySelector("#discardTop"),
  discardPreview: document.querySelector("#discardPreview"),
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
let syncMode = apiBaseUrl ? "server" : "peer";
let pollTimer = null;
let presenceTimer = null;
let presence = {};
let connectionText = "Not connected";
let pollFailures = 0;
let selected = new Set();
let drawnCardIds = new Set();
const savedSession = loadLocalSession();
let state = normalizeState(savedSession?.state);
let lastObservedTurnSeat = state.currentTurn;
let turnAudioContext = null;
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
  if (!game.game) game.game = "handfoot";
  if (!Number.isFinite(game.revision)) game.revision = 0;
  if (!seats.includes(game.roundStarter)) game.roundStarter = "south";
  upgradeGameDeckCount(game);
  if (typeof game.firstUpCardOpen !== "boolean") game.firstUpCardOpen = looksLikeOpeningUpCard(game);
  return game;
}

function isFirstUpCardAvailable(game = state) {
  if (!game?.discard?.[0] || game.discard.length !== 1) return false;
  if (game.turnStage !== "firstDiscard" && game.turnStage !== "draw") return false;
  if (game.currentTurn !== game.roundStarter) return false;
  if (game.firstUpCardOpen === false) return false;
  return game.firstUpCardOpen === true || looksLikeOpeningUpCard(game);
}

function looksLikeOpeningUpCard(game) {
  if (!inferOpeningDeckCount(game)) return false;
  return hasOpeningPlayerShape(game);
}

function inferOpeningDeckCount(game) {
  if (!game?.players || !game?.discard?.[0] || game.discard.length !== 1) return null;
  const counts = [deckCount, ...previousDeckCounts];
  return counts.find((count) => game.stock?.length === openingStockSizeFor(count) && hasOpeningPlayerShape(game)) || null;
}

function hasOpeningPlayerShape(game) {
  return seats.every((seat) => {
    const player = game.players[seat];
    return (
      player?.active === "hand" &&
      player.hand?.length === startingHandSize &&
      player.foot?.length === startingFootSize &&
      (player.melds || []).length === 0 &&
      !player.opened
    );
  });
}

function upgradeGameDeckCount(game) {
  const currentDeckCount = inferDeckCountFromCards(game);
  if (!currentDeckCount || currentDeckCount >= deckCount || game.wentOut) {
    if (currentDeckCount && !Number.isFinite(game.deckCount)) game.deckCount = currentDeckCount;
    return;
  }
  const addedCards = deterministicShuffle(
    createDeck(deckCount - currentDeckCount, currentDeckCount),
    deckUpgradeSeed(game, currentDeckCount)
  );
  game.stock = [...(game.stock || []), ...addedCards];
  game.deckCount = deckCount;
}

function inferDeckCountFromCards(game) {
  const cardDecks = allGameCards(game)
    .map((card) => deckIndexFromCardId(card?.id))
    .filter((index) => Number.isFinite(index));
  const inferredDeckCount = cardDecks.length ? Math.max(...cardDecks) + 1 : 0;
  const storedDeckCount = Number.isFinite(game?.deckCount) ? game.deckCount : 0;
  return Math.max(inferredDeckCount, storedDeckCount);
}

function deckIndexFromCardId(id) {
  const match = typeof id === "string" ? id.match(/-(\d+)$/) : null;
  return match ? Number(match[1]) : null;
}

function allGameCards(game) {
  const cards = [...(game?.stock || []), ...(game?.discard || [])];
  seats.forEach((seat) => {
    const player = game?.players?.[seat];
    if (!player) return;
    cards.push(...(player.hand || []), ...(player.foot || []));
    (player.melds || []).forEach((meld) => cards.push(...(meld.cards || []), ...(meld.killed || [])));
  });
  return cards;
}

function deckUpgradeSeed(game, currentDeckCount) {
  return [
    "handfoot-deck-upgrade",
    currentDeckCount,
    deckCount,
    game.round,
    game.roundStarter,
    allGameCards(game)
      .map((card) => card.id)
      .sort()
      .join(","),
  ].join("|");
}

function deterministicShuffle(deck, seedText) {
  const cards = [...deck];
  let seed = hashString(seedText);
  for (let i = cards.length - 1; i > 0; i -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function openingStockSizeFor(count) {
  return count * cardsPerDeck - seats.length * (startingHandSize + startingFootSize) - 1;
}

function bumpStateRevision() {
  state.revision = stateRevision() + 1;
}

function shouldAcceptRemoteState(remoteState) {
  if (stateRevision(remoteState) <= stateRevision()) return false;
  if (opponentUpdateChangesMyCards(remoteState)) return false;
  return true;
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

function opponentUpdateChangesMyCards(remoteState) {
  if (!mySeat || remoteState.currentTurn === mySeat || state.wentOut || remoteState.wentOut) return false;
  return playerCardsSignature(remoteState, mySeat) !== playerCardsSignature(state, mySeat);
}

function playerCardsSignature(game, seat) {
  const player = game?.players?.[seat];
  if (!player) return "";
  return `${player.active || "hand"}:${cardIdSignature(player.hand)}:${cardIdSignature(player.foot)}`;
}

function cardIdSignature(cards) {
  return Array.isArray(cards) ? cards.map((card) => card.id).join(",") : "";
}

function createDeck(count = deckCount, startIndex = 0) {
  const ranks = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
  const suits = ["S", "H", "D", "C"];
  const deck = [];
  for (let d = startIndex; d < startIndex + count; d += 1) {
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
  const starter = previous ? nextSeat(previous.roundStarter || "south") : "south";
  const players = {
    south: { hand: deck.splice(0, 11), foot: deck.splice(0, 11), active: "hand", melds: [], opened: false },
    north: { hand: deck.splice(0, 11), foot: deck.splice(0, 11), active: "hand", melds: [], opened: false },
  };
  return {
    game: "handfoot",
    revision: previous ? stateRevision(previous) : 0,
    round,
    scores: previous ? previous.scores : { south: 0, north: 0 },
    stock: deck,
    discard: [deck.shift()],
    players,
    deckCount,
    roundStarter: starter,
    currentTurn: starter,
    turnStage: "firstDiscard",
    firstUpCardOpen: true,
    wentOut: null,
    message: `${seatNames[starter]} may take the first up-card, or skip it and draw normally.`,
  };
}

function loadLocalSession() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(localSessionKey);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session?.state?.game === "handfoot" && typeof session.room === "string") return session;
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
    // Local storage can be unavailable in private browsing; the game still works without refresh restore.
  }
}

function clearLocalSession() {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(localSessionKey);
  } catch (error) {
    // Ignore storage cleanup failures.
  }
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
  const savedRoom = savedSession?.room?.toUpperCase();
  const room = currentRoomCode();
  if (room && savedRoom === room) {
    connectServerRoom(room, humanSeats.host, "Reconnected", "The saved room is no longer available. Host a new room or ask for a fresh room code.");
    return;
  }
  role = "host";
  mySeat = humanSeats.host;
  createRoom();
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
  const code = makeRoomCode("CARDS");
  setConnection("Creating room...");
  peer = new Peer(code, peerOptions());
  peer.on("open", (id) => {
    els.roomInput.value = id.toUpperCase();
    setConnection("Room ready");
    saveLocalSession();
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

function wireHostPeerConnection(conn) {
  conn.on("open", () => {
    setConnection("Connected");
    sendPeerState(conn);
    [300, 900, 1800].forEach((delay) => setTimeout(() => sendPeerState(conn), delay));
  });
  conn.on("data", (message) => {
    if (message.type === "requestState") sendPeerState(conn);
    if (message.type === "state") {
      state = normalizeState(message.state);
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
    saveLocalSession();
    render();
  });
  conn.on("data", (message) => {
    if (message.type === "state") {
      state = normalizeState(message.state);
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
    startPolling(payload.room);
    startPresence(payload.room);
    saveLocalSession();
    render();
  } catch (error) {
    setConnection("Local relay unavailable");
    state.message = "The remote relay is not responding. Try again in a moment.";
    render();
  }
}

async function joinRoom() {
  if (syncMode !== "server") {
    joinPeerRoom();
    return;
  }
  const room = currentRoomCode();
  if (!room) return setConnection("Enter a room code");
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
    startPolling(room);
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

function joinPeerRoom() {
  const room = els.roomInput.value.trim().toUpperCase();
  if (!room) return setConnection("Enter a room code");
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

function startPolling(room) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
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

function broadcast() {
  bumpStateRevision();
  saveLocalSession();
  if (syncMode === "peer" && peerConn?.open) {
    sendPeerState();
    render();
    return;
  }
  if (role && syncMode === "server") putServerState();
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

function setConnection(text) {
  connectionText = text;
  renderConnection();
}

function renderConnection() {
  els.connectionStatus.textContent = `${connectionText}${partnerPresenceText()}`;
}

function partnerPresenceText() {
  if (syncMode !== "server" || !role || !mySeat) return "";
  const seat = nextSeat(mySeat);
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
  clearLocalSession();
  peerConn?.close();
  peer?.destroy();
  peerConn = null;
  peer = null;
  role = null;
  mySeat = null;
  selected.clear();
  drawnCardIds.clear();
  els.roomInput.value = "";
  state = createGame();
  setConnection(syncMode === "server" ? "Remote relay ready" : "Browser relay ready");
  render();
}

function takeStock() {
  if (!isMyTurn()) return;
  if (state.turnStage === "firstDiscard") {
    const amount = Math.min(rule().draw, state.stock.length);
    const drawn = state.stock.splice(0, amount);
    activeCards(mySeat).push(...drawn);
    markDrawn(drawn);
    state.turnStage = "play";
    state.firstUpCardOpen = false;
    state.message = `${seatNames[mySeat]} skipped the first up-card and drew ${amount} from stock.`;
    broadcast();
    return;
  }
  if (state.turnStage !== "draw") return;
  const amount = Math.min(rule().draw, state.stock.length);
  const drawn = state.stock.splice(0, amount);
  activeCards(mySeat).push(...drawn);
  markDrawn(drawn);
  state.turnStage = "play";
  state.firstUpCardOpen = false;
  state.message = `${seatNames[mySeat]} drew ${amount} from stock.`;
  broadcast();
}

function takeFirstDiscard() {
  if (!isMyTurn() || !isFirstUpCardAvailable()) return;
  const card = state.discard.shift();
  activeCards(mySeat).push(card);
  markDrawn([card]);
  state.turnStage = "firstDiscardTaken";
  state.firstUpCardOpen = false;
  state.message = `${seatNames[mySeat]} took the first up-card. Discard one card, then draw normally.`;
  broadcast();
}

function skipFirstDiscard() {
  if (!isMyTurn() || state.turnStage !== "firstDiscard") return;
  state.turnStage = "draw";
  state.firstUpCardOpen = true;
  state.message = `${seatNames[mySeat]} skipped the first up-card. Draw from stock or pick up the discard pile.`;
  broadcast();
}

function takeDiscard() {
  if (!isMyTurn()) return;
  if (isFirstUpCardAvailable()) {
    takeFirstDiscard();
    return;
  }
  if (state.turnStage !== "draw") return;
  const check = canTakeDiscard(mySeat);
  if (!check.ok) {
    state.message = check.reason;
    render();
    return;
  }
  const count = Math.min(5, state.discard.length);
  const drawn = state.discard.splice(0, count);
  activeCards(mySeat).push(...drawn);
  markDrawn(drawn);
  state.turnStage = "play";
  state.message = `${seatNames[mySeat]} picked up ${count} from discard.`;
  broadcast();
}

function markDrawn(cards) {
  drawnCardIds = new Set(cards.map((card) => card.id));
}

function canTakeDiscard(seat) {
  const top = state.discard[0];
  if (!top) return { ok: false, reason: "Discard is empty" };
  if (isFirstUpCardAvailable()) return { ok: true, opening: true };
  if (isWild(top)) return { ok: false, reason: "Cannot pick up a wild card on top" };
  const matches = activeCards(seat).filter((card) => card.rank === top.rank && !isWild(card));
  const hasMatchingMeld = state.players[seat].melds.some((meld) => meld.rank === top.rank);
  if (matches.length < 2 && !hasMatchingMeld) {
    return { ok: false, reason: `Need two natural ${rankName(top.rank)}s or a matching meld` };
  }
  return { ok: true };
}

function handleDiscardPileClick() {
  if (isFirstUpCardAvailable()) {
    takeFirstDiscard();
    return;
  }
  takeDiscard();
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
  } else if (result.kill) {
    const meld = player.melds[targetIndex];
    meld.killed = [...(meld.killed || []), ...cards];
  } else {
    player.melds[targetIndex].cards.push(...cards);
  }
  if (!player.opened && openingTotal(player.melds) >= rule().open) player.opened = true;
  selected.clear();
  maybeMoveToFoot(mySeat);
  if (!player.opened) {
    state.message = `${seatNames[mySeat]} melded ${cards.length} cards. Opening total is ${openingTotal(player.melds)}/${rule().open}; meld another set before discarding.`;
  } else if (result.kill) {
    state.message = `${seatNames[mySeat]} killed ${cards.length} ${rankName(result.rank)}${cards.length === 1 ? "" : "s"}.`;
  } else {
    state.message = `${seatNames[mySeat]} melded ${cards.length} cards.`;
  }
  maybeFinishAfterPlay(mySeat, false);
  broadcast();
}

function discardSelected() {
  const returningFirstDiscard = state.turnStage === "firstDiscardTaken";
  if (!isMyTurn() || (state.turnStage !== "play" && !returningFirstDiscard)) return;
  const cards = selectedCards();
  if (cards.length !== 1) {
    state.message = "Select exactly one card to discard.";
    render();
    return;
  }
  if (returningFirstDiscard) {
    const card = cards[0];
    setActiveCards(mySeat, activeCards(mySeat).filter((item) => item.id !== card.id));
    state.discard.unshift(card);
    drawnCardIds.delete(card.id);
    selected.clear();
    state.turnStage = "draw";
    state.message = `${seatNames[mySeat]} returned one card after taking the first up-card. Draw normally.`;
    broadcast();
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
    const mover = mySeat;
    endTurn();
    state.message = `${seatNames[mover]} moved into the Foot. ${seatNames[state.currentTurn]} to draw.`;
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
  drawnCardIds.clear();
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
    total += scoredMeldCards(meld).reduce((sum, card) => sum + cardValue(card), 0);
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
  if (player.melds.some((meld) => meld.rank === rank && meld.cards.length < 7)) {
    return { ok: false, reason: "Add to your open meld for that rank." };
  }
  if (!dirtyRatioOk(cards)) return { ok: false, reason: "Naturals must outnumber wild cards." };
  return { ok: true, rank };
}

function validateAddMeld(cards, meld) {
  if (!meld) return { ok: false, reason: "Choose a meld first." };
  if (meld.cards.length >= 7) return validateKilledCards(cards, meld);
  if (meld.cards.length + cards.length > 7) return { ok: false, reason: "A book can only have 7 cards." };
  const bad = cards.some((card) => !isWild(card) && card.rank !== meld.rank);
  if (bad) return { ok: false, reason: "Cards must match the meld rank." };
  if (meld.rank === "3" && cards.some((card) => isWild(card) || isRedThree(card))) return { ok: false, reason: "Black 3 books use only black 3s." };
  if (!dirtyRatioOk([...meld.cards, ...cards])) return { ok: false, reason: "Naturals must outnumber wild cards." };
  return { ok: true, rank: meld.rank };
}

function validateKilledCards(cards, meld) {
  if (cards.some(isWild)) return { ok: false, reason: "Kill matching natural cards only." };
  if (cards.some((card) => card.rank !== meld.rank)) return { ok: false, reason: `Kill ${rankName(meld.rank)}s on that book.` };
  if (meld.rank === "3" && cards.some(isRedThree)) return { ok: false, reason: "Only black 3s can be killed on a black 3 book." };
  return { ok: true, rank: meld.rank, kill: true };
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
  return melds.flatMap(scoredMeldCards).reduce((sum, card) => sum + cardValue(card), 0);
}

function scoredMeldCards(meld) {
  return [...meld.cards, ...(meld.killed || [])];
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

function maybePlayTurnSound() {
  if (!mySeat) {
    lastObservedTurnSeat = state.currentTurn;
    return;
  }
  const becameMyTurn = lastObservedTurnSeat !== state.currentTurn && state.currentTurn === mySeat && !state.wentOut;
  lastObservedTurnSeat = state.currentTurn;
  if (becameMyTurn) playTurnSound();
}

function armTurnSound() {
  if (turnAudioContext) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  turnAudioContext = new AudioContext();
  turnAudioContext.resume?.();
}

function playTurnSound() {
  if (!turnAudioContext) return;
  turnAudioContext.resume?.();
  const now = turnAudioContext.currentTime;
  [
    { at: 0, frequency: 659.25, peak: 0.22, duration: 0.32 },
    { at: 0.13, frequency: 783.99, peak: 0.2, duration: 0.34 },
    { at: 0.28, frequency: 1046.5, peak: 0.24, duration: 0.46 },
    { at: 0.56, frequency: 523.25, peak: 0.28, duration: 0.72 },
  ].forEach(({ at, frequency, peak, duration }) => playBellTone(now + at, frequency, peak, duration));
}

function playBellTone(start, frequency, peakGain, duration = 0.72) {
  const toneGain = turnAudioContext.createGain();
  toneGain.gain.setValueAtTime(0.0001, start);
  toneGain.gain.exponentialRampToValueAtTime(peakGain, start + 0.025);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  toneGain.connect(turnAudioContext.destination);
  [
    { frequency, level: 1 },
    { frequency: frequency * 1.5, level: 0.34 },
    { frequency: frequency * 2, level: 0.18 },
  ].forEach(({ frequency: partialFrequency, level }) => {
    const oscillator = turnAudioContext.createOscillator();
    const partialGain = turnAudioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(partialFrequency, start);
    partialGain.gain.setValueAtTime(level, start);
    oscillator.connect(partialGain);
    partialGain.connect(toneGain);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  });
}

function render() {
  maybePlayTurnSound();
  els.hostBtn.disabled = Boolean(role);
  els.joinBtn.disabled = Boolean(role);
  els.copyBtn.disabled = !els.roomInput.value.trim();
  els.roomStatus.textContent = els.roomInput.value.trim().toUpperCase() || "-";
  renderConnection();
  els.seatStatus.textContent = mySeat ? seatNames[mySeat] : "Choose Host or Join";
  els.southScore.textContent = state.scores.south;
  els.northScore.textContent = state.scores.north;
  els.roundStatus.textContent = `${state.round} · draw ${rule().draw}`;
  els.stockCount.textContent = state.stock.length;
  els.discardTop.innerHTML = state.discard[0] ? cardMarkup(state.discard[0]) : "-";
  els.discardTop.className = state.discard[0] ? cardSuitClass(state.discard[0]) : "empty-discard";
  renderDiscardPreview();
  els.discardCount.textContent = `${state.discard.length} cards`;
  els.gameMessage.textContent = state.message;
  els.turnStatus.textContent = state.wentOut ? "Round complete" : `${seatNames[state.currentTurn]} ${turnStageLabel()}`;
  els.handLabel.textContent = mySeat ? `Your ${state.players[mySeat].active}` : "Your cards";
  renderSeats();
  renderMelds("south", els.southMelds);
  renderMelds("north", els.northMelds);
  renderHand();
  renderActions();
  saveLocalSession();
}

function renderSeats() {
  seats.forEach((seat) => {
    const player = state.players[seat];
    const meldTotal = openingTotal(player.melds);
    const opened = player.opened || meldTotal >= rule().open;
    const el = seat === "south" ? els.seatSouth : els.seatNorth;
    el.classList.toggle("active-seat", state.currentTurn === seat && !state.wentOut);
    el.innerHTML = `
      <div class="player-heading">
        <div class="player-name">${seatNames[seat]}${seat === mySeat ? " (you)" : ""}</div>
        <div class="player-score"><span>Score</span><strong>${state.scores[seat]}</strong></div>
      </div>
      <div class="player-info-row">
        <span class="player-card-count">Hand ${player.hand.length} · Foot ${player.foot.length}</span>
        <span class="player-meld-total ${opened ? "open" : ""}">Meld ${meldTotal}/${rule().open}</span>
      </div>
    `;
    el.append(createPlayerMeldBoard(seat));
  });
}

function createPlayerMeldBoard(seat) {
  const board = document.createElement("div");
  board.className = "player-meld-grid";
  sortedMelds(seat).forEach(({ meld, index }) => {
    board.append(createMeldElement(seat, meld, index));
  });
  return board;
}

function renderDiscardPreview() {
  els.discardPreview.innerHTML = "";
  state.discard.slice(0, 5).forEach((card, index) => {
    const item = document.createElement("span");
    item.className = `discard-mini ${cardSuitClass(card)} ${index === 0 ? "top" : ""}`;
    item.innerHTML = cardMarkup(card);
    els.discardPreview.append(item);
  });
}

function renderMelds(seat, container) {
  container.innerHTML = "";
  sortedMelds(seat).forEach(({ meld, index }) => {
    container.append(createMeldElement(seat, meld, index));
  });
}

function sortedMelds(seat) {
  return state.players[seat].melds
    .map((meld, index) => ({ meld, index }))
    .sort((a, b) => rankOrder[a.meld.rank] - rankOrder[b.meld.rank] || a.index - b.index);
}

function createMeldElement(seat, meld, index) {
  const isCompleteBook = meld.cards.length >= 7;
  const canPlayOnMeld = seat === mySeat && isMyTurn() && state.turnStage === "play";
  const item = document.createElement("div");
  item.className = `meld ${isCompleteBook ? "complete-book" : ""} ${canPlayOnMeld ? "meld-add-target" : ""}`;
  item.innerHTML = `
    <div class="meld-title">
      <span class="meld-count">${scoredMeldCards(meld).length}</span>
      <span class="meld-rank">${rankName(meld.rank)}</span>
    </div>
    ${isCompleteBook ? completeMeldMarkup(meld) : `<div class="meld-cards">${displayMeldCards(meld).map(meldCardMarkup).join("")}</div>`}
  `;
  if (canPlayOnMeld) {
    item.tabIndex = 0;
    item.role = "button";
    item.ariaLabel = `${isCompleteBook ? "Kill" : "Add"} selected cards ${isCompleteBook ? "on" : "to"} ${rankName(meld.rank)}`;
    item.addEventListener("click", () => meldSelected(index));
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      meldSelected(index);
    });
  }
  return item;
}

function displayMeldCards(meld) {
  return [...meld.cards].sort((a, b) => {
    if (isWild(a) !== isWild(b)) return isWild(a) ? -1 : 1;
    return rankOrder[a.rank] - rankOrder[b.rank] || a.suit.localeCompare(b.suit);
  });
}

function completeMeldMarkup(meld) {
  const type = bookType(meld);
  const topCard = completeBookTopCard(meld);
  const killedCount = (meld.killed || []).length;
  const typeLabel = type === "black3" ? "black 3" : type;
  return `
    <div class="complete-book-pile ${type}" title="${rankName(meld.rank)} ${typeLabel} book${killedCount ? `, ${killedCount} killed` : ""}">
      <span class="book-card book-card-back"></span>
      <span class="book-card book-card-middle"></span>
      <span class="book-card book-card-top ${cardSuitClass(topCard)}">${cardMarkup(topCard)}</span>
      <span class="book-type-badge">${typeLabel}</span>
      ${killedCount ? `<span class="book-kill-count">+${killedCount}</span>` : ""}
    </div>
  `;
}

function completeBookTopCard(meld) {
  const naturals = sortCards(meld.cards.filter((card) => !isWild(card)));
  return naturals[0] || displayMeldCards(meld)[0];
}

function meldCardMarkup(card) {
  return `<span class="meld-card ${cardSuitClass(card)}" title="${cardLabel(card)}">${cardMarkup(card)}</span>`;
}

function renderHand() {
  els.hand.innerHTML = "";
  if (!mySeat) return;
  sortCards(activeCards(mySeat)).forEach((card) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `card ${cardSuitClass(card)} ${isWild(card) ? "wild" : ""} ${isRedThree(card) ? "red-three" : ""} ${drawnCardIds.has(card.id) && isMyTurn() ? "drawn-card" : ""} ${selected.has(card.id) ? "selected" : ""}`;
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
  if (!mySeat) {
    addAction("Host or join to play", () => {}, true);
    return;
  }
  if (state.wentOut) {
    addAction("Round complete", () => {}, true);
    return;
  }
  if (!isMyTurn()) {
    addAction(`Waiting for ${seatNames[state.currentTurn]}`, () => {}, true);
    return;
  }
  if (isMyTurn() && state.turnStage === "firstDiscard") {
    addAction("Take first up-card", takeFirstDiscard);
    addAction("Skip and choose draw", skipFirstDiscard);
  }
  if (isMyTurn() && state.turnStage === "firstDiscardTaken") {
    addAction("Discard selected", discardSelected);
  }
  if (isMyTurn() && state.turnStage === "draw") {
    addAction("Draw stock", takeStock);
    const check = canTakeDiscard(mySeat);
    addAction(check.opening ? "Take first up-card" : check.ok ? "Pick discard" : check.reason, takeDiscard, !check.ok);
  }
  if (isMyTurn() && state.turnStage === "play") {
    addAction("New meld", () => meldSelected(null));
    addAction("Discard selected", discardSelected);
  }
}

function turnStageLabel() {
  if (state.turnStage === "firstDiscard") return "first up-card";
  if (state.turnStage === "firstDiscardTaken") return "return discard";
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

function confirmNewRound() {
  const ok = window.confirm("Start a new round? This will end the current round for both players.");
  if (!ok) return;
  state = createGame(state);
  selected.clear();
  drawnCardIds.clear();
  broadcast();
}

function confirmNewGame() {
  const ok = window.confirm("Start a new game? This will reset scores and the current round for both players.");
  if (!ok) return;
  const previousRevision = stateRevision();
  state = createGame();
  state.revision = previousRevision;
  selected.clear();
  drawnCardIds.clear();
  broadcast();
}

els.hostBtn.addEventListener("click", hostRoom);
els.joinBtn.addEventListener("click", joinRoom);
els.clearRoomBtn.addEventListener("click", clearRoomCode);
els.stockBtn.addEventListener("click", takeStock);
els.discardBtn.addEventListener("click", handleDiscardPileClick);
els.newRoundBtn.addEventListener("click", confirmNewRound);
els.newGameBtn.addEventListener("click", confirmNewGame);
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
["pointerdown", "keydown"].forEach((eventName) => window.addEventListener(eventName, armTurnSound, { once: true }));

if (savedSession?.room) els.roomInput.value = savedSession.room;
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
