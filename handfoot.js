const hostSeat = "south";
const twoPlayerSeats = ["south", "north"];
const fourPlayerSeats = ["south", "west", "north", "east"];
const seatNames = { south: "South", west: "West", north: "North", east: "East" };
const teamNames = { ns: "North/South", ew: "East/West" };
const teamBySeat = { south: "ns", north: "ns", west: "ew", east: "ew" };
const deckCountByPlayerCount = { 2: 6, 4: 8 };
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
const deckCount = deckCountByPlayerCount[2];
const previousDeckCounts = [4, 6];
const localSessionKey = "remote-card-table-handfoot-session-v1";
const remoteRelayOrigin = "https://cards.boyzofsummerpics.com";
const apiBaseUrl =
  typeof location !== "undefined" && location.hostname.endsWith("github.io") ? remoteRelayOrigin : "";

const els = {
  app: document.querySelector(".handfoot-app"),
  hostBtn: document.querySelector("#hostBtn"),
  playerCountSelect: document.querySelector("#playerCountSelect"),
  copyBtn: document.querySelector("#copyBtn"),
  clearRoomBtn: document.querySelector("#clearRoomBtn"),
  joinBtn: document.querySelector("#joinBtn"),
  seatSelect: document.querySelector("#seatSelect"),
  roomInput: document.querySelector("#roomInput"),
  connectionStatus: document.querySelector("#connectionStatus"),
  seatStatus: document.querySelector("#seatStatus"),
  roomStatus: document.querySelector("#roomStatus"),
  scoreboard: document.querySelector("#scoreboard"),
  roundEndPanel: document.querySelector("#roundEndPanel"),
  seatPanels: document.querySelector("#seatPanels"),
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
  meldPanels: document.querySelector("#meldPanels"),
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
let lastObservedWentOut = state.wentOut;
let turnAudioContext = null;
let turnAudioUnlocked = false;
let pendingJackpotSoundKey = null;
let activeWinnerSoundKey = null;
let stoppedWinnerSoundKey = null;
let winnerSoundLoopTimer = null;
let winnerSoundGain = null;
let fireworkNoiseBuffer = null;
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

function selectedPlayerCount() {
  return Number(els.playerCountSelect?.value) === 4 ? 4 : 2;
}

function setSelectedPlayerCount(count) {
  if (els.playerCountSelect) els.playerCountSelect.value = String(count === 4 ? 4 : 2);
}

function playerCountForGame(game = state) {
  return Number(game?.playerCount) === 4 ? 4 : 2;
}

function seatsForPlayerCount(count) {
  return count === 4 ? fourPlayerSeats : twoPlayerSeats;
}

function seatsForGame(game = state) {
  return seatsForPlayerCount(playerCountForGame(game));
}

function seatDisplayOrder(game = state) {
  return playerCountForGame(game) === 4 ? ["north", "west", "east", "south"] : ["north", "south"];
}

function joinableSeatsForGame(game = state) {
  return seatDisplayOrder(game).filter((seat) => seat !== hostSeat);
}

function isPartnersGame(game = state) {
  return playerCountForGame(game) === 4;
}

function ownerForSeat(seat, game = state) {
  return isPartnersGame(game) ? teamBySeat[seat] : seat;
}

function ownerName(owner) {
  return teamNames[owner] || seatNames[owner] || owner;
}

function meldOwnersForGame(game = state) {
  return isPartnersGame(game) ? ["ns", "ew"] : seatsForGame(game);
}

function scoreOwnersForGame(game = state) {
  return meldOwnersForGame(game);
}

function seatsForOwner(owner, game = state) {
  if (!isPartnersGame(game)) return seatsForGame(game).includes(owner) ? [owner] : [];
  return seatsForGame(game).filter((seat) => teamBySeat[seat] === owner);
}

function meldArea(owner, game = state) {
  if (owner === "ns" || owner === "ew") return game.teams?.[owner];
  return game.players?.[owner];
}

function meldAreaForSeat(seat, game = state) {
  return meldArea(ownerForSeat(seat, game), game);
}

function scoreForOwner(owner, game = state) {
  return Number(game?.scores?.[owner]) || 0;
}

function deckCountForPlayerCount(count) {
  return deckCountByPlayerCount[count === 4 ? 4 : 2];
}

function deckCountForGame(game = state) {
  return deckCountForPlayerCount(playerCountForGame(game));
}

function stateRevision(game = state) {
  return Number.isFinite(game?.revision) ? game.revision : 0;
}

function normalizeState(game) {
  if (!game) return createGame(null, selectedPlayerCount());
  if (!game.game) game.game = "handfoot";
  game.playerCount = playerCountForGame(game);
  if (!Number.isFinite(game.revision)) game.revision = 0;
  ensurePlayers(game);
  ensureMeldAreas(game);
  ensureScores(game);
  if (!seatsForGame(game).includes(game.roundStarter)) game.roundStarter = hostSeat;
  if (!seatsForGame(game).includes(game.currentTurn)) game.currentTurn = game.roundStarter;
  upgradeGameDeckCount(game);
  if (typeof game.firstUpCardOpen !== "boolean") game.firstUpCardOpen = looksLikeOpeningUpCard(game);
  return game;
}

function ensurePlayers(game) {
  if (!game.players || typeof game.players !== "object") game.players = {};
  seatsForGame(game).forEach((seat) => {
    const player = game.players[seat] || {};
    player.hand = Array.isArray(player.hand) ? player.hand : [];
    player.foot = Array.isArray(player.foot) ? player.foot : [];
    player.active = player.active === "foot" ? "foot" : "hand";
    player.melds = Array.isArray(player.melds) ? player.melds : [];
    player.opened = Boolean(player.opened);
    game.players[seat] = player;
  });
}

function ensureMeldAreas(game) {
  if (!isPartnersGame(game)) return;
  const oldTeams = game.teams || {};
  game.teams = {
    ns: normalizeTeamArea(oldTeams.ns, [game.players.south, game.players.north]),
    ew: normalizeTeamArea(oldTeams.ew, [game.players.west, game.players.east]),
  };
}

function normalizeTeamArea(area, fallbackPlayers) {
  if (area && typeof area === "object") {
    area.melds = Array.isArray(area.melds) ? area.melds : [];
    area.opened = Boolean(area.opened);
    return area;
  }
  return {
    melds: fallbackPlayers.flatMap((player) => (Array.isArray(player?.melds) ? player.melds : [])),
    opened: fallbackPlayers.some((player) => player?.opened),
  };
}

function ensureScores(game) {
  const previous = game.scores || {};
  if (isPartnersGame(game)) {
    game.scores = {
      ns: Number(previous.ns ?? ((Number(previous.south) || 0) + (Number(previous.north) || 0))) || 0,
      ew: Number(previous.ew ?? ((Number(previous.west) || 0) + (Number(previous.east) || 0))) || 0,
    };
    return;
  }
  game.scores = {
    south: Number(previous.south ?? previous.ns) || 0,
    north: Number(previous.north) || 0,
  };
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
  const counts = [deckCountForGame(game), ...previousDeckCounts];
  return counts.find((count) => game.stock?.length === openingStockSizeFor(count, game) && hasOpeningPlayerShape(game)) || null;
}

function hasOpeningPlayerShape(game) {
  return seatsForGame(game).every((seat) => {
    const player = game.players[seat];
    return (
      player?.active === "hand" &&
      player.hand?.length === startingHandSize &&
      player.foot?.length === startingFootSize &&
      (player.melds || []).length === 0
    );
  }) && meldOwnersForGame(game).every((owner) => (meldArea(owner, game)?.melds || []).length === 0 && !meldArea(owner, game)?.opened);
}

function upgradeGameDeckCount(game) {
  const currentDeckCount = inferDeckCountFromCards(game);
  const targetDeckCount = deckCountForGame(game);
  if (!currentDeckCount || currentDeckCount >= targetDeckCount || game.wentOut) {
    if (currentDeckCount && !Number.isFinite(game.deckCount)) game.deckCount = currentDeckCount;
    return;
  }
  const addedCards = deterministicShuffle(
    createDeck(targetDeckCount - currentDeckCount, currentDeckCount),
    deckUpgradeSeed(game, currentDeckCount, targetDeckCount)
  );
  game.stock = [...(game.stock || []), ...addedCards];
  game.deckCount = targetDeckCount;
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
  seatsForGame(game).forEach((seat) => {
    const player = game?.players?.[seat];
    if (!player) return;
    cards.push(...(player.hand || []), ...(player.foot || []));
  });
  meldOwnersForGame(game).forEach((owner) => {
    (meldArea(owner, game)?.melds || []).forEach((meld) => cards.push(...(meld.cards || []), ...(meld.killed || [])));
  });
  return cards;
}

function deckUpgradeSeed(game, currentDeckCount, targetDeckCount = deckCountForGame(game)) {
  return [
    "handfoot-deck-upgrade",
    currentDeckCount,
    targetDeckCount,
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

function openingStockSizeFor(count, game = state) {
  return count * cardsPerDeck - seatsForGame(game).length * (startingHandSize + startingFootSize) - 1;
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
  return seat === hostSeat ? "host" : "guest";
}

function chooseJoinSeat(game, requestedSeat, roomPresence = {}, restoring = false) {
  const activeSeats = seatsForGame(game);
  if (restoring && activeSeats.includes(requestedSeat)) return requestedSeat;
  if (requestedSeat === hostSeat && activeSeats.includes(requestedSeat)) return requestedSeat;
  if (requestedSeat && requestedSeat !== hostSeat && activeSeats.includes(requestedSeat) && !roomPresence?.[requestedSeat]?.online) {
    return requestedSeat;
  }
  const openSeat = joinableSeatsForGame(game).find((seat) => !roomPresence?.[seat]?.online);
  return openSeat || joinableSeatsForGame(game)[0] || hostSeat;
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

function createGame(previous = null, playerCount = previous ? playerCountForGame(previous) : selectedPlayerCount()) {
  const count = playerCount === 4 ? 4 : 2;
  const deckTarget = deckCountForPlayerCount(count);
  const deck = shuffle(createDeck(deckTarget));
  const round = previous ? Math.min(previous.round + 1, 4) : 1;
  const activeSeats = seatsForPlayerCount(count);
  const previousStarter = previous && playerCountForGame(previous) === count ? previous.roundStarter || hostSeat : null;
  const starter = previousStarter ? nextSeat(previousStarter, count) : hostSeat;
  const players = {};
  activeSeats.forEach((seat) => {
    players[seat] = { hand: deck.splice(0, 11), foot: deck.splice(0, 11), active: "hand", melds: [], opened: false };
  });
  const scores = previous && playerCountForGame(previous) === count ? normalizedScoresForCount(previous.scores, count) : initialScores(count);
  return {
    game: "handfoot",
    playerCount: count,
    revision: previous ? stateRevision(previous) : 0,
    round,
    scores,
    stock: deck,
    discard: [deck.shift()],
    players,
    teams: count === 4 ? { ns: { melds: [], opened: false }, ew: { melds: [], opened: false } } : null,
    deckCount: deckTarget,
    roundStarter: starter,
    currentTurn: starter,
    turnStage: "firstDiscard",
    firstUpCardOpen: true,
    wentOut: null,
    message: `${seatNames[starter]} may take the first up-card, or skip it and draw normally.`,
  };
}

function initialScores(count) {
  return count === 4 ? { ns: 0, ew: 0 } : { south: 0, north: 0 };
}

function normalizedScoresForCount(scores, count) {
  const game = { playerCount: count, scores: scores || {} };
  ensureScores(game);
  return game.scores;
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
    if (selectedPlayerCount() === 4) {
      state.message = "4-player partners needs the hosted relay. Use the public cards link for partner rooms.";
      render();
      return;
    }
    hostPeerRoom();
    return;
  }
  const savedRoom = savedSession?.room?.toUpperCase();
  const room = currentRoomCode();
  if (room && savedRoom === room) {
    connectServerRoom(room, hostSeat, "Reconnected", "The saved room is no longer available. Host a new room or ask for a fresh room code.");
    return;
  }
  role = "host";
  mySeat = hostSeat;
  state = createGame(null, selectedPlayerCount());
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
  mySeat = hostSeat;
  state = createGame(null, 2);
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
  await connectServerRoom(room, els.seatSelect.value || "north", "Connected", "Ask the host for the newest room code, then try Join again.");
}

async function reconnectSavedServerRoom() {
  if (!savedSession?.room || !Object.keys(seatNames).includes(savedSession.seat)) return false;
  return connectServerRoom(
    savedSession.room,
    savedSession.seat,
    "Reconnected",
    "The saved room is no longer available. Host a new room or ask for a fresh room code.",
    true
  );
}

async function connectServerRoom(room, seat, connectedText, missingMessage, restoring = false) {
  if (Object.keys(seatNames).includes(seat)) {
    role = roleForSeat(seat);
    mySeat = seat;
  }
  els.roomInput.value = room;
  setConnection(restoring ? "Reconnecting..." : "Connecting...");
  render();
  try {
    const response = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(room)}/state`));
    if (!response.ok) throw new Error("Room not found");
    const payload = await response.json();
    const remoteState = normalizeState(payload.state);
    const savedState = normalizeState(savedSession?.state);
    presence = payload.presence || {};
    state = restoring && stateRevision(savedState) > stateRevision(remoteState) ? savedState : remoteState;
    mySeat = chooseJoinSeat(state, seat, presence, restoring);
    role = roleForSeat(mySeat);
    setSelectedPlayerCount(playerCountForGame(state));
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
  mySeat = "north";
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
  const others = seatsForGame().filter((seat) => seat !== mySeat);
  const online = others.filter((seat) => presence[seat]?.online);
  const waiting = others.filter((seat) => !presence[seat]?.online);
  if (!waiting.length) return ` • ${online.map((seat) => seatNames[seat]).join(", ")} online`;
  if (online.length) return ` • ${online.map((seat) => seatNames[seat]).join(", ")} online • waiting for ${waiting.map((seat) => seatNames[seat]).join(", ")}`;
  if (waiting.length === 1 && typeof presence[waiting[0]]?.lastSeenAgoMs === "number") {
    return ` • ${seatNames[waiting[0]]} last seen ${formatAgo(presence[waiting[0]].lastSeenAgoMs)}`;
  }
  return ` • waiting for ${waiting.map((seat) => seatNames[seat]).join(", ")}`;
}

function formatAgo(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

function clearRoomCode() {
  stopWinnerSound(false);
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
  state = createGame(null, selectedPlayerCount());
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
  const hasMatchingMeld = meldAreaForSeat(seat).melds.some((meld) => meld.rank === top.rank);
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
  const area = meldAreaForSeat(mySeat);
  const active = activeCards(mySeat);
  const result = targetIndex === null ? validateNewMeld(cards, area) : validateAddMeld(cards, area.melds[targetIndex]);
  if (!result.ok) {
    state.message = result.reason;
    render();
    return;
  }
  setActiveCards(mySeat, active.filter((card) => !selected.has(card.id)));
  if (targetIndex === null) {
    area.melds.push({ rank: result.rank, cards });
  } else if (result.kill) {
    const meld = area.melds[targetIndex];
    meld.killed = [...(meld.killed || []), ...cards];
  } else {
    area.melds[targetIndex].cards.push(...cards);
  }
  if (!area.opened && openingTotal(area.melds) >= rule().open) area.opened = true;
  selected.clear();
  maybeMoveToFoot(mySeat);
  if (!area.opened) {
    state.message = `${seatNames[mySeat]} melded ${cards.length} cards. Opening total is ${openingTotal(area.melds)}/${rule().open}; meld another set before discarding.`;
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
  const area = meldAreaForSeat(mySeat);
  if (!area.opened && area.melds.length > 0) {
    state.message = `Opening total is ${openingTotal(area.melds)}/${rule().open}. Meld another set before discarding.`;
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
  scoreOwnersForGame().forEach((owner) => {
    state.scores[owner] += scoreOwner(owner, winner);
  });
  state.turnStage = "complete";
  state.message = `${seatNames[winner]} WENT OUT. Round scored.`;
}

function scoreOwner(owner, winner) {
  const area = meldArea(owner);
  const winnerOwner = ownerForSeat(winner);
  let total = 0;
  area.melds.forEach((meld) => {
    total += scoredMeldCards(meld).reduce((sum, card) => sum + cardValue(card), 0);
    const book = bookType(meld);
    if (book === "clean") total += 500;
    if (book === "dirty") total += 300;
    if (book === "black3") total += 1000;
  });
  seatsForOwner(owner).forEach((seat) => {
    const player = state.players[seat];
    const unplayed = [...player.hand, ...player.foot];
    total -= unplayed.reduce((sum, card) => sum + cardValue(card), 0);
    if (owner !== winnerOwner) total -= unplayed.filter(isRedThree).length * 500;
  });
  if (owner === winnerOwner) total += 100;
  return total;
}

function validateNewMeld(cards, area) {
  if (cards.length < 3) return { ok: false, reason: "A new meld needs at least 3 cards." };
  const naturals = cards.filter((card) => !isWild(card));
  if (!naturals.length) return { ok: false, reason: "A meld needs natural cards." };
  const rank = naturals[0].rank;
  if (naturals.some((card) => card.rank !== rank)) return { ok: false, reason: "Natural cards in a meld must match." };
  if (isRedThree(naturals[0])) return { ok: false, reason: "Red 3s cannot be melded." };
  if (rank === "3" && naturals.some((card) => card.suit === "H" || card.suit === "D")) return { ok: false, reason: "Only black 3s can make a book." };
  if (rank === "3" && cards.some(isWild)) return { ok: false, reason: "Black 3 book must be clean." };
  if (cards.length > 7) return { ok: false, reason: "A book tops out at 7 cards." };
  if (area.melds.some((meld) => meld.rank === rank && meld.cards.length < 7)) {
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
  const books = meldAreaForSeat(seat).melds.map(bookType);
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

function nextSeat(seat, count = playerCountForGame()) {
  const order = seatsForPlayerCount(count);
  const index = order.indexOf(seat);
  return order[(index + 1) % order.length] || hostSeat;
}

function isMyTurn() {
  return mySeat && state.currentTurn === mySeat && !state.wentOut;
}

function maybePlayTurnSound() {
  maybePlayWinnerSound();
  if (!mySeat) {
    lastObservedTurnSeat = state.currentTurn;
    lastObservedWentOut = state.wentOut;
    return;
  }
  const becameMyTurn = lastObservedTurnSeat !== state.currentTurn && state.currentTurn === mySeat && !state.wentOut;
  lastObservedTurnSeat = state.currentTurn;
  lastObservedWentOut = state.wentOut;
  if (becameMyTurn) playTurnSound();
}

function maybePlayWinnerSound() {
  const key = jackpotSoundKey();
  if (!key) {
    stopWinnerSound(false);
    pendingJackpotSoundKey = null;
    return;
  }
  if (key === stoppedWinnerSoundKey || key === pendingJackpotSoundKey || key === activeWinnerSoundKey) return;
  if (!startWinnerSoundLoop(key)) pendingJackpotSoundKey = key;
}

function jackpotSoundKey() {
  if (!state.wentOut) return null;
  return `${state.round}:${state.wentOut}:${stateRevision()}`;
}

async function armTurnSound() {
  const context = createTurnAudioContext();
  if (!context) return false;
  try {
    await context.resume?.();
  } catch (error) {
    // Browsers may reject until a trusted user interaction; the next click/key retries.
  }
  unlockTurnAudio();
  if (startPendingWinnerSound()) render();
  return canPlayAudio();
}

function unlockTurnAudio() {
  if (!turnAudioContext || (turnAudioUnlocked && turnAudioContext.state === "running")) return;
  const now = turnAudioContext.currentTime;
  const gain = turnAudioContext.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
  gain.connect(turnAudioContext.destination);
  const oscillator = turnAudioContext.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(440, now);
  oscillator.connect(gain);
  oscillator.start(now);
  oscillator.stop(now + 0.04);
  turnAudioUnlocked = turnAudioContext.state === "running";
}

function canPlayAudio() {
  return Boolean(turnAudioContext && turnAudioUnlocked && turnAudioContext.state === "running");
}

function createTurnAudioContext() {
  if (turnAudioContext) return turnAudioContext;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  turnAudioContext = new AudioContext();
  turnAudioContext.addEventListener?.("statechange", handleTurnAudioStateChange);
  return turnAudioContext;
}

function handleTurnAudioStateChange() {
  if (turnAudioContext?.state !== "running") return;
  turnAudioUnlocked = true;
  if (startPendingWinnerSound()) render();
}

function playTurnSound() {
  if (!createTurnAudioContext() || !canPlayAudio()) return false;
  turnAudioContext.resume?.();
  const now = turnAudioContext.currentTime;
  [
    { at: 0, frequency: 659.25, peak: 0.22, duration: 0.32 },
    { at: 0.13, frequency: 783.99, peak: 0.2, duration: 0.34 },
    { at: 0.28, frequency: 1046.5, peak: 0.24, duration: 0.46 },
    { at: 0.56, frequency: 523.25, peak: 0.28, duration: 0.72 },
  ].forEach(({ at, frequency, peak, duration }) => playBellTone(now + at, frequency, peak, duration));
  return true;
}

function playJackpotSound() {
  if (!createTurnAudioContext() || !canPlayAudio()) return false;
  turnAudioContext.resume?.();
  const now = turnAudioContext.currentTime + 0.02;
  const output = createWinnerSoundOutput();
  if (!output) return false;
  [
    { at: 0, lift: 430, pop: 82, color: 1820, pan: -0.42 },
    { at: 0.78, lift: 610, pop: 108, color: 2440, pan: 0.38 },
    { at: 1.52, lift: 520, pop: 74, color: 3140, pan: -0.08 },
  ].forEach(({ at, lift, pop, color, pan }) => playFirework(now + at, lift, pop, color, pan, output));
  playFireworkFinale(now + 2.36, output);
  return true;
}

function createWinnerSoundOutput() {
  if (!turnAudioContext) return null;
  if (!winnerSoundGain) {
    winnerSoundGain = turnAudioContext.createGain();
    winnerSoundGain.gain.setValueAtTime(1.25, turnAudioContext.currentTime);
    winnerSoundGain.connect(turnAudioContext.destination);
  }
  return winnerSoundGain;
}

function startWinnerSoundLoop(key = jackpotSoundKey()) {
  if (!key) return false;
  if (activeWinnerSoundKey === key && winnerSoundLoopTimer) return true;
  if (!playJackpotSound()) {
    pendingJackpotSoundKey = key;
    return false;
  }
  if (pendingJackpotSoundKey === key) pendingJackpotSoundKey = null;
  stoppedWinnerSoundKey = null;
  if (activeWinnerSoundKey !== key) {
    clearInterval(winnerSoundLoopTimer);
    winnerSoundLoopTimer = null;
  }
  activeWinnerSoundKey = key;
  if (!winnerSoundLoopTimer) {
    winnerSoundLoopTimer = setInterval(() => {
      if (jackpotSoundKey() !== key || key === stoppedWinnerSoundKey) {
        stopWinnerSound(false);
        return;
      }
      playJackpotSound();
    }, 4400);
  }
  return true;
}

function startPendingWinnerSound() {
  return pendingJackpotSoundKey ? startWinnerSoundLoop(pendingJackpotSoundKey) : false;
}

async function playWinnerSoundNow() {
  const key = jackpotSoundKey();
  if (!key) return;
  stoppedWinnerSoundKey = null;
  pendingJackpotSoundKey = key;
  await armTurnSound();
  if (startPendingWinnerSound()) {
    render();
    return;
  }
  state.message = "Sound is still blocked. Click Play winner sound again, or check browser and device volume.";
  render();
}

function stopWinnerSound(rememberStop = true) {
  const key = activeWinnerSoundKey || pendingJackpotSoundKey || jackpotSoundKey();
  if (rememberStop && key) stoppedWinnerSoundKey = key;
  clearInterval(winnerSoundLoopTimer);
  winnerSoundLoopTimer = null;
  activeWinnerSoundKey = null;
  pendingJackpotSoundKey = null;
  if (winnerSoundGain && turnAudioContext) {
    const now = turnAudioContext.currentTime;
    winnerSoundGain.gain.cancelScheduledValues(now);
    winnerSoundGain.gain.setValueAtTime(0.0001, now);
    winnerSoundGain.disconnect();
    winnerSoundGain = null;
  }
}

function stopWinnerSoundNow() {
  stopWinnerSound();
  render();
}

function winnerSoundIsPlaying() {
  return Boolean(winnerSoundLoopTimer && activeWinnerSoundKey === jackpotSoundKey());
}

function playFirework(start, liftFrequency, popFrequency, sparkleFrequency, pan = 0, output = turnAudioContext.destination) {
  playFireworkLaunch(start, liftFrequency, pan, output);
  playFireworkExplosion(start + 0.56, popFrequency, sparkleFrequency, pan, output);
  playFireworkCrackle(start + 0.62, sparkleFrequency, pan, output);
  playFireworkSizzle(start + 0.82, sparkleFrequency * 0.64, pan, output);
}

function playFireworkFinale(start, output = turnAudioContext.destination) {
  [
    { at: 0, lift: 490, pop: 96, color: 1940, pan: -0.58 },
    { at: 0.18, lift: 660, pop: 126, color: 2680, pan: 0.56 },
    { at: 0.4, lift: 750, pop: 88, color: 3400, pan: -0.16 },
    { at: 0.66, lift: 580, pop: 116, color: 2220, pan: 0.18 },
  ].forEach(({ at, lift, pop, color, pan }) => playFirework(start + at, lift, pop, color, pan, output));
}

function playFireworkLaunch(start, frequency, pan = 0, output = turnAudioContext.destination) {
  const whistleGain = turnAudioContext.createGain();
  whistleGain.gain.setValueAtTime(0.0001, start);
  whistleGain.gain.exponentialRampToValueAtTime(0.16, start + 0.06);
  whistleGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.54);
  connectSoundOutput(whistleGain, output, pan, start);
  const oscillator = turnAudioContext.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 2.85, start + 0.5);
  oscillator.connect(whistleGain);
  oscillator.start(start);
  oscillator.stop(start + 0.58);

  const rushGain = turnAudioContext.createGain();
  rushGain.gain.setValueAtTime(0.0001, start);
  rushGain.gain.exponentialRampToValueAtTime(0.1, start + 0.08);
  rushGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.48);
  const rushFilter = turnAudioContext.createBiquadFilter();
  rushFilter.type = "highpass";
  rushFilter.frequency.setValueAtTime(520, start);
  rushFilter.frequency.exponentialRampToValueAtTime(2400, start + 0.46);
  rushGain.connect(rushFilter);
  connectSoundOutput(rushFilter, output, pan, start);
  const rush = createNoiseSource();
  rush.connect(rushGain);
  rush.start(start);
  rush.stop(start + 0.5);
}

function playFireworkExplosion(start, frequency, sparkleFrequency, pan = 0, output = turnAudioContext.destination) {
  const boomGain = turnAudioContext.createGain();
  boomGain.gain.setValueAtTime(0.0001, start);
  boomGain.gain.exponentialRampToValueAtTime(0.62, start + 0.012);
  boomGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
  connectSoundOutput(boomGain, output, pan, start);
  const boom = turnAudioContext.createOscillator();
  boom.type = "sine";
  boom.frequency.setValueAtTime(frequency, start);
  boom.frequency.exponentialRampToValueAtTime(frequency * 0.32, start + 0.58);
  boom.connect(boomGain);
  boom.start(start);
  boom.stop(start + 0.74);

  const burstGain = turnAudioContext.createGain();
  burstGain.gain.setValueAtTime(0.0001, start);
  burstGain.gain.exponentialRampToValueAtTime(0.56, start + 0.006);
  burstGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
  const filter = turnAudioContext.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(1200, start);
  filter.frequency.exponentialRampToValueAtTime(120, start + 0.28);
  connectSoundOutput(filter, output, pan, start);
  burstGain.connect(filter);
  const noise = createNoiseSource();
  noise.connect(burstGain);
  noise.start(start);
  noise.stop(start + 0.32);

  playFireworkBrightPop(start + 0.035, sparkleFrequency, pan, output);
}

function playFireworkBrightPop(start, frequency, pan = 0, output = turnAudioContext.destination) {
  const gain = turnAudioContext.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.11, start + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
  connectSoundOutput(gain, output, pan, start);
  const oscillator = turnAudioContext.createOscillator();
  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.22, start + 0.08);
  oscillator.connect(gain);
  oscillator.start(start);
  oscillator.stop(start + 0.18);
}

function playFireworkCrackle(start, frequency, pan = 0, output = turnAudioContext.destination) {
  for (let i = 0; i < 18; i += 1) {
    const at = start + i * 0.04 + ((i * 17) % 11) * 0.003;
    const spreadPan = clampPan(pan + (((i * 31) % 9) - 4) * 0.11);
    const gain = turnAudioContext.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.11 + (i % 4) * 0.026, at + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
    const filter = turnAudioContext.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(frequency + ((i * 211) % 1700), at);
    filter.Q.setValueAtTime(12, at);
    connectSoundOutput(filter, output, spreadPan, at);
    gain.connect(filter);
    const noise = createNoiseSource();
    noise.connect(gain);
    noise.start(at);
    noise.stop(at + 0.13);
  }
}

function playFireworkSizzle(start, frequency, pan = 0, output = turnAudioContext.destination) {
  const gain = turnAudioContext.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.14, start + 0.035);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.88);
  const filter = turnAudioContext.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.setValueAtTime(frequency, start);
  filter.Q.setValueAtTime(0.8, start);
  connectSoundOutput(filter, output, pan, start);
  gain.connect(filter);
  const noise = createNoiseSource();
  noise.connect(gain);
  noise.start(start);
  noise.stop(start + 0.9);
}

function connectSoundOutput(node, output, pan = 0, start = turnAudioContext.currentTime) {
  if (!turnAudioContext.createStereoPanner) {
    node.connect(output);
    return;
  }
  const panner = turnAudioContext.createStereoPanner();
  panner.pan.setValueAtTime(clampPan(pan), start);
  node.connect(panner);
  panner.connect(output);
}

function clampPan(pan) {
  return Math.max(-1, Math.min(1, pan));
}

function createNoiseSource() {
  if (!fireworkNoiseBuffer) {
    const length = Math.max(1, Math.floor(turnAudioContext.sampleRate * 1.2));
    fireworkNoiseBuffer = turnAudioContext.createBuffer(1, length, turnAudioContext.sampleRate);
    const data = fireworkNoiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
  }
  const source = turnAudioContext.createBufferSource();
  source.buffer = fireworkNoiseBuffer;
  return source;
}

function playBassThump(start, output = turnAudioContext.destination) {
  const gain = turnAudioContext.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.22, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
  gain.connect(output);
  const oscillator = turnAudioContext.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(130.81, start);
  oscillator.frequency.exponentialRampToValueAtTime(65.41, start + 0.28);
  oscillator.connect(gain);
  oscillator.start(start);
  oscillator.stop(start + 0.34);
}

function playCoinSparkle(start, frequency, output = turnAudioContext.destination) {
  const filter = turnAudioContext.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(frequency, start);
  filter.Q.setValueAtTime(8, start);
  filter.connect(output);
  const gain = turnAudioContext.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.16, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
  gain.connect(filter);
  const oscillator = turnAudioContext.createOscillator();
  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.18, start + 0.06);
  oscillator.connect(gain);
  oscillator.start(start);
  oscillator.stop(start + 0.2);
}

function playSparkleSweep(start, fromFrequency, toFrequency, duration, output = turnAudioContext.destination) {
  const gain = turnAudioContext.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.08, start + 0.035);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  gain.connect(output);
  const oscillator = turnAudioContext.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(fromFrequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(toFrequency, start + duration);
  oscillator.connect(gain);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playWinnerChord(start, frequencies, peakGain, duration, output = turnAudioContext.destination) {
  frequencies.forEach((frequency, index) => {
    playBellTone(start + index * 0.018, frequency, peakGain * (index === 0 ? 1 : 0.72), duration - index * 0.04, output);
  });
}

function playPrizeTone(start, frequency, peakGain, duration, output = turnAudioContext.destination) {
  const toneGain = turnAudioContext.createGain();
  toneGain.gain.setValueAtTime(0.0001, start);
  toneGain.gain.exponentialRampToValueAtTime(peakGain, start + 0.012);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  toneGain.connect(output);
  const oscillator = turnAudioContext.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.connect(toneGain);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playBellTone(start, frequency, peakGain, duration = 0.72, output = turnAudioContext.destination) {
  const toneGain = turnAudioContext.createGain();
  toneGain.gain.setValueAtTime(0.0001, start);
  toneGain.gain.exponentialRampToValueAtTime(peakGain, start + 0.025);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  toneGain.connect(output);
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
  els.app.classList.toggle("partners-mode", isPartnersGame());
  els.app.classList.toggle("two-player-mode", !isPartnersGame());
  els.hostBtn.disabled = Boolean(role);
  els.joinBtn.disabled = Boolean(role);
  els.playerCountSelect.disabled = Boolean(role);
  els.copyBtn.disabled = !els.roomInput.value.trim();
  els.roomStatus.textContent = els.roomInput.value.trim().toUpperCase() || "-";
  setSelectedPlayerCount(playerCountForGame());
  renderSeatSelect();
  renderConnection();
  els.seatStatus.textContent = mySeat ? `${seatNames[mySeat]}${isPartnersGame() ? ` • ${ownerName(ownerForSeat(mySeat))}` : ""}` : "Choose Host or Join";
  renderScoreboard();
  els.stockCount.textContent = state.stock.length;
  els.discardTop.innerHTML = state.discard[0] ? cardMarkup(state.discard[0]) : "-";
  els.discardTop.className = state.discard[0] ? cardSuitClass(state.discard[0]) : "empty-discard";
  renderDiscardPreview();
  els.discardCount.textContent = `${state.discard.length} cards`;
  els.gameMessage.textContent = state.message;
  els.turnStatus.textContent = state.wentOut ? "Round complete" : `${seatNames[state.currentTurn]} ${turnStageLabel()}`;
  els.handLabel.textContent = mySeat ? `Your ${state.players[mySeat].active}` : "Your cards";
  renderSeats();
  renderRoundEnd();
  renderMeldPanels();
  renderHand();
  renderActions();
  saveLocalSession();
}

function renderSeatSelect() {
  if (!els.seatSelect) return;
  const current = els.seatSelect.value;
  const options = joinableSeatsForGame();
  els.seatSelect.innerHTML = options
    .map((seat) => `<option value="${seat}">${seatNames[seat]}${isPartnersGame() ? ` • ${ownerName(ownerForSeat(seat))}` : ""}</option>`)
    .join("");
  els.seatSelect.value = options.includes(current) ? current : options[0] || "north";
  els.seatSelect.disabled = Boolean(role);
}

function renderScoreboard() {
  els.scoreboard.innerHTML = `
    ${scoreOwnersForGame().map((owner) => `
      <div>
        <span>${ownerName(owner)}</span>
        <strong>${scoreForOwner(owner)}</strong>
      </div>
    `).join("")}
    <div>
      <span>Round</span>
      <strong>${state.round} · draw ${rule().draw}</strong>
    </div>
  `;
}

function renderRoundEnd() {
  els.roundEndPanel.innerHTML = "";
  els.roundEndPanel.hidden = !state.wentOut;
  if (!state.wentOut) return;
  els.roundEndPanel.innerHTML = `
    <div class="round-reveal-grid">
      ${seatsForGame().map(roundRevealSeatMarkup).join("")}
    </div>
  `;
}

function roundRevealSeatMarkup(seat) {
  const player = state.players[seat];
  const isWinner = seat === state.wentOut;
  return `
    <article class="round-reveal-seat ${isWinner ? "went-out" : ""}">
      ${isWinner ? fireworkMarkup() : ""}
      <div class="round-reveal-heading">
        <h2>${seatNames[seat]}${seat === mySeat ? " (you)" : ""}${isWinner ? `<span class="winner-badge">Winner</span>` : ""}</h2>
        <span>${remainingCardCount(player)} left</span>
      </div>
      ${roundRevealPileMarkup("Hand", player.hand)}
      ${roundRevealPileMarkup("Foot", player.foot)}
    </article>
  `;
}

function roundRevealPileMarkup(label, cards) {
  const sorted = sortCards(cards || []);
  return `
    <div class="round-reveal-pile">
      <div class="round-reveal-pile-title">
        <span>${label}</span>
        <strong>${sorted.length}</strong>
      </div>
      <div class="round-reveal-cards">${sorted.length ? sorted.map(revealCardMarkup).join("") : `<span class="round-reveal-empty">empty</span>`}</div>
    </div>
  `;
}

function revealCardMarkup(card) {
  return `<span class="round-reveal-card ${cardSuitClass(card)}" title="${cardLabel(card)}">${cardMarkup(card)}</span>`;
}

function remainingCardCount(player) {
  return (player.hand || []).length + (player.foot || []).length;
}

function renderSeats() {
  els.seatPanels.innerHTML = "";
  seatDisplayOrder().forEach((seat) => {
    if (!state.players[seat]) return;
    els.seatPanels.append(createSeatElement(seat));
  });
}

function createSeatElement(seat) {
  const player = state.players[seat];
  const owner = ownerForSeat(seat);
  const area = meldArea(owner);
  const meldTotal = openingTotal(area.melds);
  const opened = area.opened || meldTotal >= rule().open;
  const el = document.createElement("div");
  el.className = `player team-${owner}`;
  el.classList.toggle("active-seat", state.currentTurn === seat && !state.wentOut);
  el.classList.toggle("winner-seat", state.wentOut === seat);
  el.innerHTML = `
      <div class="player-heading">
        <div class="player-name">${seatNames[seat]}${seat === mySeat ? " (you)" : ""}${state.wentOut === seat ? `<span class="winner-mini">Winner</span>` : ""}</div>
        <div class="player-score"><span>${isPartnersGame() ? ownerName(owner) : "Score"}</span><strong>${scoreForOwner(owner)}</strong></div>
      </div>
      <div class="player-info-row">
        <span class="player-card-count">Hand ${player.hand.length} · Foot ${player.foot.length}</span>
        <span class="player-meld-total ${opened ? "open" : ""}">Meld ${meldTotal}/${rule().open}</span>
      </div>
      ${state.wentOut === seat ? fireworkMarkup() : ""}
    `;
  if (!isPartnersGame()) el.append(createPlayerMeldBoard(owner));
  return el;
}

function fireworkMarkup() {
  const bursts = [
    { x: "17%", y: "28%", color: "#ffd36d", delay: "0s", radius: 2.85 },
    { x: "76%", y: "21%", color: "#8ed1ff", delay: "0.32s", radius: 2.65 },
    { x: "50%", y: "49%", color: "#ff9b8d", delay: "0.66s", radius: 3.05 },
    { x: "82%", y: "71%", color: "#a8ffbf", delay: "1.02s", radius: 2.75 },
    { x: "28%", y: "73%", color: "#fff6d6", delay: "1.28s", radius: 2.35 },
  ];
  return `
    <div class="winner-fireworks" aria-hidden="true">
      ${bursts.map(fireworkCometMarkup).join("")}
      ${bursts.map(fireworkBurstMarkup).join("")}
    </div>
  `;
}

function fireworkCometMarkup({ x, color, delay }, index) {
  const drift = index % 2 ? "-2.4rem" : "2rem";
  return `<i class="firework-comet" style="--x: ${x}; --c: ${color}; --d: ${delay}; --dx: ${drift};"></i>`;
}

function fireworkBurstMarkup({ x, y, color, delay, radius }) {
  const angles = [0, 23, 45, 68, 90, 113, 135, 158, 180, 203, 225, 248, 270, 293, 315, 338];
  return `
    <span class="firework-burst" style="--x: ${x}; --y: ${y}; --c: ${color}; --d: ${delay};">
      <i class="firework-core"></i>
      ${angles.map((angle, index) => fireworkSparkMarkup(angle, index, radius)).join("")}
    </span>
  `;
}

function fireworkSparkMarkup(angle, index, radius) {
  const distance = (radius + (index % 4) * 0.18).toFixed(2);
  const delay = ((index % 5) * 0.014).toFixed(3);
  const duration = (2.08 + (index % 3) * 0.08).toFixed(2);
  return `<i class="firework-spark" style="--a: ${angle}deg; --r: ${distance}rem; --sd: ${delay}s; --t: ${duration}s;"></i>`;
}

function createPlayerMeldBoard(owner) {
  const board = document.createElement("div");
  board.className = "player-meld-grid";
  sortedMelds(owner).forEach(({ meld, index }) => {
    board.append(createMeldElement(owner, meld, index));
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

function renderMeldPanels() {
  els.meldPanels.hidden = !isPartnersGame();
  els.meldPanels.innerHTML = "";
  if (!isPartnersGame()) return;
  meldOwnersForGame().forEach((owner) => {
    const area = meldArea(owner);
    const meldTotal = openingTotal(area.melds);
    const panel = document.createElement("div");
    panel.className = `team-meld-panel team-${owner}`;
    panel.innerHTML = `
      <div class="team-meld-heading">
        <h2>${ownerName(owner)} Melds</h2>
        <span class="player-meld-total ${area.opened || meldTotal >= rule().open ? "open" : ""}">Meld ${meldTotal}/${rule().open}</span>
      </div>
      <div class="meld-grid"></div>
    `;
    renderMelds(owner, panel.querySelector(".meld-grid"));
    els.meldPanels.append(panel);
  });
}

function renderMelds(owner, container) {
  container.innerHTML = "";
  sortedMelds(owner).forEach(({ meld, index }) => {
    container.append(createMeldElement(owner, meld, index));
  });
}

function sortedMelds(owner) {
  return meldArea(owner).melds
    .map((meld, index) => ({ meld, index }))
    .sort((a, b) => rankOrder[a.meld.rank] - rankOrder[b.meld.rank] || a.index - b.index);
}

function createMeldElement(owner, meld, index) {
  const isCompleteBook = meld.cards.length >= 7;
  const canPlayOnMeld = mySeat && owner === ownerForSeat(mySeat) && isMyTurn() && state.turnStage === "play";
  const item = document.createElement("div");
  item.className = `meld ${isCompleteBook ? "complete-book" : ""} ${canPlayOnMeld ? "meld-add-target" : ""}`;
  item.innerHTML = `
    <div class="meld-title">
      <span class="meld-count" title="normal/wild">${meldCountLabel(meld)}</span>
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

function meldCountLabel(meld) {
  const cards = scoredMeldCards(meld);
  const naturals = cards.filter((card) => !isWild(card) && card.rank === meld.rank).length;
  const wilds = cards.filter(isWild).length;
  return `${naturals}/${wilds}`;
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
    addAction(winnerSoundIsPlaying() ? "Stop winner sound" : "Play winner sound", winnerSoundIsPlaying() ? stopWinnerSoundNow : playWinnerSoundNow);
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
  stopWinnerSound();
  const ok = window.confirm("Start a new round? This will end the current round for everyone in the room.");
  if (!ok) {
    render();
    return;
  }
  state = createGame(state);
  selected.clear();
  drawnCardIds.clear();
  broadcast();
}

function confirmNewGame() {
  stopWinnerSound();
  const ok = window.confirm("Start a new game? This will reset scores and the current round for everyone in the room.");
  if (!ok) {
    render();
    return;
  }
  const previousRevision = stateRevision();
  state = createGame();
  state.revision = previousRevision;
  selected.clear();
  drawnCardIds.clear();
  broadcast();
}

function handlePlayerCountChange() {
  if (role) {
    setSelectedPlayerCount(playerCountForGame());
    return;
  }
  stopWinnerSound(false);
  state = createGame(null, selectedPlayerCount());
  selected.clear();
  drawnCardIds.clear();
  render();
}

els.hostBtn.addEventListener("click", hostRoom);
els.playerCountSelect.addEventListener("change", handlePlayerCountChange);
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
["pointerdown", "keydown"].forEach((eventName) => window.addEventListener(eventName, armTurnSound));

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
