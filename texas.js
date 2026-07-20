const seats = ["south", "north"];
const seatNames = { south: "South", north: "North" };
const humanSeats = { host: "south", guest: "north" };
const suitSymbols = { S: "♠", H: "♥", D: "♦", C: "♣" };
const rankOrder = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const startingStack = 1000;
const smallBlind = 10;
const bigBlind = 20;
const bettingPhases = ["preflop", "flop", "turn", "river"];
const localSessionKey = "remote-card-table-holdem-session-v1";
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
  southStack: document.querySelector("#southStack"),
  northStack: document.querySelector("#northStack"),
  potStatus: document.querySelector("#potStatus"),
  mainPot: document.querySelector("#mainPot"),
  handNumber: document.querySelector("#handNumber"),
  blindStatus: document.querySelector("#blindStatus"),
  dealerButton: document.querySelector("#dealerButton"),
  communityCards: document.querySelector("#communityCards"),
  gameMessage: document.querySelector("#gameMessage"),
  actionControls: document.querySelector("#actionControls"),
  newHandBtn: document.querySelector("#newHandBtn"),
  newGameBtn: document.querySelector("#newGameBtn"),
  hand: document.querySelector("#hand"),
  turnStatus: document.querySelector("#turnStatus"),
  phaseStatus: document.querySelector("#phaseStatus"),
  actionLog: document.querySelector("#actionLog"),
  showdownPanel: document.querySelector("#showdownPanel"),
  seats: {
    north: document.querySelector("#seatNorth"),
    south: document.querySelector("#seatSouth"),
  },
};

let role = null;
let mySeat = null;
let syncMode = apiBaseUrl ? "server" : "peer";
let pollTimer = null;
let presenceTimer = null;
let presence = {};
let connectionText = "Not connected";
let pollFailures = 0;
let peer = null;
let peerConn = null;
const savedSession = loadLocalSession();
let state = savedSession?.state || createGame();

function apiUrl(path) {
  return `${apiBaseUrl}${path}`;
}

function createDeck() {
  const suits = Object.keys(suitSymbols);
  const ranks = Object.keys(rankOrder);
  return suits.flatMap((suit) => ranks.map((rank) => ({ suit, rank, id: `${rank}${suit}` })));
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
  const stacks = Object.fromEntries(seats.map((seat) => [seat, previous?.players?.[seat]?.chips ?? startingStack]));
  if (previous && seats.some((seat) => stacks[seat] <= 0)) return createPausedTable(previous, stacks);
  const dealer = previous ? nextSeat(previous.dealer || "south") : "south";
  const handNumber = previous ? previous.handNumber + 1 : 1;
  return dealHand(handNumber, dealer, stacks);
}

function createPausedTable(previous, stacks) {
  const brokeSeat = seats.find((seat) => stacks[seat] <= 0);
  return {
    game: "holdem",
    handNumber: previous.handNumber,
    smallBlind,
    bigBlind,
    dealer: previous.dealer || "south",
    deck: [],
    community: [],
    pot: 0,
    currentBet: 0,
    minRaise: bigBlind,
    phase: "complete",
    currentTurn: null,
    players: Object.fromEntries(seats.map((seat) => [seat, createPlayer(stacks[seat], [])])),
    showdown: null,
    actionLog: [`${seatNames[brokeSeat]} is out of play chips.`],
    message: `${seatNames[brokeSeat]} is out of play chips. Start a new game to reset stacks.`,
  };
}

function dealHand(handNumber, dealer, stacks) {
  const deck = shuffle(createDeck());
  const players = Object.fromEntries(seats.map((seat) => [seat, createPlayer(stacks[seat], [])]));
  for (let i = 0; i < 2; i += 1) {
    seats.forEach((seat) => players[seat].hole.push(deck.shift()));
  }

  const table = {
    game: "holdem",
    handNumber,
    smallBlind,
    bigBlind,
    dealer,
    deck,
    community: [],
    pot: 0,
    currentBet: 0,
    minRaise: bigBlind,
    phase: "preflop",
    currentTurn: dealer,
    players,
    showdown: null,
    actionLog: [],
    message: `${seatNames[dealer]} has the dealer button. Blinds are posted.`,
  };

  postBlind(table, dealer, smallBlind);
  postBlind(table, nextSeat(dealer), bigBlind);
  table.currentBet = Math.max(...seats.map((seat) => table.players[seat].streetBet));
  table.actionLog.unshift(`${seatNames[dealer]} posts ${smallBlind}; ${seatNames[nextSeat(dealer)]} posts ${bigBlind}.`);
  table.currentTurn = firstActionableFrom(table, dealer);
  if (!table.currentTurn) {
    dealRemainingBoardFor(table);
    table.message = "Both players are all-in from the blinds. Resolve the showdown.";
  }
  return table;
}

function createPlayer(chips, hole) {
  return {
    chips,
    hole,
    streetBet: 0,
    committed: 0,
    folded: false,
    allIn: chips <= 0,
    acted: false,
  };
}

function postBlind(table, seat, amount) {
  const player = table.players[seat];
  const paid = Math.min(player.chips, amount);
  player.chips -= paid;
  player.streetBet += paid;
  player.committed += paid;
  player.allIn = player.chips === 0;
  table.pot += paid;
}

function loadLocalSession() {
  try {
    const session = JSON.parse(localStorage.getItem(localSessionKey));
    if (session?.state?.game === "holdem") return session;
  } catch (error) {
    localStorage.removeItem(localSessionKey);
  }
  return null;
}

function saveLocalSession() {
  try {
    localStorage.setItem(localSessionKey, JSON.stringify({
      state,
      room: els.roomInput.value.trim().toUpperCase(),
      updatedAt: Date.now(),
    }));
  } catch (error) {
    // Private browsing can block local storage; remote sync still works without it.
  }
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
  const code = makeRoomCode("HOLD");
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
      state = message.state;
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
    const response = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(room)}/state`));
    if (!response.ok) throw new Error("Room not found");
    const payload = await response.json();
    state = payload.state;
    presence = payload.presence || {};
    setConnection("Connected");
    startStatePolling(room);
    startPresence(room);
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
  localStorage.removeItem(localSessionKey);
  peerConn?.close();
  peer?.destroy();
  peerConn = null;
  peer = null;
  role = null;
  mySeat = null;
  els.roomInput.value = "";
  state = createGame();
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
  if (action.kind === "betting") applyBettingAction(action.seat, action.move, action.total);
  if (action.kind === "newHand") state = createGame(state);
  if (action.kind === "newGame") state = createGame();
  if (action.kind === "resolveShowdown") settleShowdown();
  broadcastState();
}

function broadcastState() {
  if (syncMode === "peer" && role === "host" && peerConn?.open) sendPeerState();
  if (role && syncMode === "server") putServerState();
  render();
}

async function putServerState() {
  const room = els.roomInput.value.trim().toUpperCase();
  if (!room) return;
  await fetch(apiUrl(`/api/rooms/${encodeURIComponent(room)}/state`), {
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
      const response = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(room)}/state`));
      if (!response.ok) return;
      const payload = await response.json();
      pollFailures = 0;
      state = payload.state;
      presence = payload.presence || presence;
      if (syncMode === "server" && role) connectionText = role === "host" ? "Room ready" : "Connected";
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

function applyBettingAction(seat, move, total) {
  if (!canSeatAct(seat)) return;
  const player = state.players[seat];
  const toCall = amountToCall(seat);

  if (move === "fold") {
    if (toCall <= 0) return;
    player.folded = true;
    player.acted = true;
    pushLog(`${seatNames[seat]} folds.`);
    finishByFold(nextSeat(seat));
    return;
  }

  if (move === "check") {
    if (toCall !== 0) return;
    player.acted = true;
    pushLog(`${seatNames[seat]} checks.`);
    continueAfterAction(seat);
    return;
  }

  if (move === "call") {
    if (toCall <= 0) return;
    const target = Math.min(state.currentBet, maxTotalBet(seat));
    const paid = commitTo(seat, target);
    player.acted = true;
    pushLog(`${seatNames[seat]} calls ${paid}${player.allIn ? " and is all-in" : ""}.`);
    continueAfterAction(seat);
    return;
  }

  if (move === "allIn") {
    commitAggressiveOrCall(seat, maxTotalBet(seat));
    return;
  }

  if (move === "raise") {
    const target = Math.floor(Number(total));
    commitAggressiveOrCall(seat, target);
  }
}

function commitAggressiveOrCall(seat, targetTotal) {
  const player = state.players[seat];
  const maxTotal = maxTotalBet(seat);
  const cleanTarget = Math.min(Math.max(targetTotal, player.streetBet), maxTotal);
  const previousBet = state.currentBet;

  if (cleanTarget <= player.streetBet) return;
  if (cleanTarget <= previousBet) {
    const paid = commitTo(seat, cleanTarget);
    player.acted = true;
    pushLog(`${seatNames[seat]} calls ${paid}${player.allIn ? " and is all-in" : ""}.`);
    continueAfterAction(seat);
    return;
  }

  const minimum = minimumAggressiveTotal();
  if (cleanTarget < minimum && cleanTarget !== maxTotal) {
    state.message = `Minimum ${previousBet > 0 ? "raise" : "bet"} is ${minimum}.`;
    return;
  }

  const paid = commitTo(seat, cleanTarget);
  const raiseSize = cleanTarget - previousBet;
  if (raiseSize >= state.minRaise) state.minRaise = raiseSize;
  state.currentBet = cleanTarget;
  seats.forEach((otherSeat) => {
    if (otherSeat !== seat && !state.players[otherSeat].folded && !state.players[otherSeat].allIn) {
      state.players[otherSeat].acted = false;
    }
  });
  player.acted = true;
  const verb = previousBet > 0 ? "raises to" : "bets";
  const allInText = player.allIn ? " and is all-in" : "";
  pushLog(`${seatNames[seat]} ${verb} ${cleanTarget}${allInText}.`);
  state.message = `${seatNames[seat]} put in ${paid} play chips.`;
  continueAfterAction(seat);
}

function commitTo(seat, targetTotal) {
  const player = state.players[seat];
  const amount = Math.max(0, Math.min(targetTotal - player.streetBet, player.chips));
  player.chips -= amount;
  player.streetBet += amount;
  player.committed += amount;
  player.allIn = player.chips === 0;
  state.pot += amount;
  return amount;
}

function continueAfterAction(seat) {
  const remaining = activeSeats();
  if (remaining.length === 1) {
    finishByFold(remaining[0]);
    return;
  }
  if (bettingRoundComplete()) {
    if (remaining.some((activeSeat) => state.players[activeSeat].allIn)) {
      dealRemainingBoard();
      settleShowdown();
      return;
    }
    advanceStreet();
    return;
  }
  const next = nextActionableSeat(seat);
  state.currentTurn = next;
  state.message = `${seatNames[next]} to act.`;
}

function bettingRoundComplete() {
  return activeSeats().every((seat) => {
    const player = state.players[seat];
    return player.allIn || (player.acted && player.streetBet === state.currentBet);
  });
}

function advanceStreet() {
  if (state.phase === "river") {
    settleShowdown();
    return;
  }
  resetStreetBets();
  dealNextStreet();
  state.phase = phaseFromBoard();
  const first = firstActionableFrom(state, nextSeat(state.dealer));
  if (!first) {
    dealRemainingBoard();
    settleShowdown();
    return;
  }
  state.currentTurn = first;
  state.message = `${phaseLabel(state.phase)} is dealt. ${seatNames[first]} acts first.`;
  pushLog(`${phaseLabel(state.phase)} dealt.`);
}

function resetStreetBets() {
  seats.forEach((seat) => {
    state.players[seat].streetBet = 0;
    state.players[seat].acted = false;
  });
  state.currentBet = 0;
  state.minRaise = state.bigBlind;
}

function dealNextStreet() {
  dealNextStreetFor(state);
}

function dealNextStreetFor(table) {
  if (table.community.length >= 5) return;
  table.deck.shift();
  const count = table.community.length === 0 ? 3 : 1;
  for (let i = 0; i < count && table.community.length < 5; i += 1) {
    table.community.push(table.deck.shift());
  }
}

function dealRemainingBoard() {
  dealRemainingBoardFor(state);
}

function dealRemainingBoardFor(table) {
  while (table.community.length < 5) dealNextStreetFor(table);
  table.phase = "showdown";
}

function settleShowdown() {
  const remaining = activeSeats();
  if (remaining.length === 1) {
    finishByFold(remaining[0]);
    return;
  }
  if (typeof Hand === "undefined") {
    state.phase = "showdown";
    state.currentTurn = null;
    state.message = "The poker hand evaluator did not load. Check the internet connection and refresh.";
    return;
  }

  const solved = Object.fromEntries(remaining.map((seat) => {
    const cards = [...state.players[seat].hole, ...state.community].map(solverCard);
    return [seat, Hand.solve(cards, "standard")];
  }));
  const winnerHands = Hand.winners(Object.values(solved));
  const winnerSeats = remaining.filter((seat) => winnerHands.includes(solved[seat]));
  const payout = awardContestablePot(winnerSeats);

  state.showdown = {
    pot: payout.pot,
    winners: winnerSeats,
    hands: Object.fromEntries(remaining.map((seat) => [seat, {
      description: solved[seat].descr,
      best: solved[seat].toArray(),
    }])),
  };
  state.pot = 0;
  state.currentBet = 0;
  state.currentTurn = null;
  state.phase = "complete";
  seats.forEach((seat) => {
    state.players[seat].streetBet = 0;
  });

  if (winnerSeats.length === 1) {
    state.message = `${seatNames[winnerSeats[0]]} wins ${payout.pot} play chips with ${solved[winnerSeats[0]].descr}.`;
    pushLog(`${seatNames[winnerSeats[0]]} wins ${payout.pot} at showdown.`);
  } else {
    state.message = `Split pot: ${winnerSeats.map((seat) => seatNames[seat]).join(" and ")} each get ${payout.share}.`;
    pushLog(`Pot split ${winnerSeats.length} ways.`);
  }
}

function finishByFold(winner) {
  const payout = awardContestablePot([winner]);
  state.showdown = { pot: payout.pot, winners: [winner], hands: {}, folded: true };
  state.pot = 0;
  state.currentBet = 0;
  state.currentTurn = null;
  state.phase = "complete";
  seats.forEach((seat) => {
    state.players[seat].streetBet = 0;
  });
  state.message = `${seatNames[winner]} wins ${payout.pot} play chips.`;
  pushLog(`${seatNames[winner]} wins the pot.`);
}

function awardContestablePot(winnerSeats) {
  const matchedCommitment = Math.min(...seats.map((seat) => state.players[seat].committed));
  seats.forEach((seat) => {
    const refund = Math.max(0, state.players[seat].committed - matchedCommitment);
    if (refund > 0) {
      state.players[seat].chips += refund;
      state.pot -= refund;
    }
  });

  const pot = state.pot;
  const share = Math.floor(pot / winnerSeats.length);
  const oddChips = pot % winnerSeats.length;
  const oddOrder = [nextSeat(state.dealer), state.dealer].filter((seat) => winnerSeats.includes(seat));
  winnerSeats.forEach((seat) => {
    state.players[seat].chips += share;
  });
  for (let i = 0; i < oddChips; i += 1) {
    state.players[oddOrder[i % oddOrder.length]].chips += 1;
  }

  return { pot, share };
}

function activeSeats() {
  return seats.filter((seat) => !state.players[seat].folded);
}

function canSeatAct(seat) {
  return bettingPhases.includes(state.phase) && state.currentTurn === seat && !state.players[seat].folded && !state.players[seat].allIn;
}

function amountToCall(seat) {
  return Math.max(0, state.currentBet - state.players[seat].streetBet);
}

function maxTotalBet(seat) {
  const player = state.players[seat];
  const opponentSeat = activeSeats().find((otherSeat) => otherSeat !== seat);
  if (!opponentSeat) return player.streetBet + player.chips;
  const opponent = state.players[opponentSeat];
  return Math.min(player.streetBet + player.chips, opponent.streetBet + opponent.chips);
}

function minimumAggressiveTotal() {
  return state.currentBet === 0 ? state.bigBlind : state.currentBet + state.minRaise;
}

function firstActionableFrom(table, startSeat) {
  let seat = startSeat;
  for (let i = 0; i < seats.length; i += 1) {
    const player = table.players[seat];
    if (!player.folded && !player.allIn) return seat;
    seat = nextSeat(seat);
  }
  return null;
}

function nextActionableSeat(currentSeat) {
  return firstActionableFrom(state, nextSeat(currentSeat));
}

function pushLog(text) {
  state.actionLog.unshift(text);
  state.actionLog = state.actionLog.slice(0, 8);
}

function nextSeat(seat) {
  return seat === "south" ? "north" : "south";
}

function phaseFromBoard() {
  if (state.community.length === 3) return "flop";
  if (state.community.length === 4) return "turn";
  if (state.community.length === 5) return "river";
  return "preflop";
}

function phaseLabel(phase) {
  if (phase === "preflop") return "Preflop";
  if (phase === "flop") return "Flop";
  if (phase === "turn") return "Turn";
  if (phase === "river") return "River";
  if (phase === "showdown") return "Showdown";
  return "Complete";
}

function render() {
  els.hostBtn.disabled = Boolean(role);
  els.joinBtn.disabled = Boolean(role);
  els.copyBtn.disabled = !els.roomInput.value.trim();
  els.roomStatus.textContent = els.roomInput.value.trim().toUpperCase() || "-";
  renderConnection();
  els.seatStatus.textContent = mySeat ? seatNames[mySeat] : "Choose Host or Join";
  els.southStack.textContent = state.players.south.chips;
  els.northStack.textContent = state.players.north.chips;
  els.potStatus.textContent = state.pot;
  els.mainPot.textContent = state.pot;
  els.handNumber.textContent = state.handNumber;
  els.blindStatus.textContent = `${state.smallBlind} / ${state.bigBlind}`;
  els.gameMessage.textContent = state.message;
  els.turnStatus.textContent = turnLabel();
  els.phaseStatus.textContent = phaseLabel(state.phase);
  els.dealerButton.className = `dealer-button ${state.dealer}`;
  els.dealerButton.title = `${seatNames[state.dealer]} dealer button`;
  renderSeats();
  renderCommunity();
  renderHand();
  renderActions();
  renderShowdown();
  renderActionLog();
  saveLocalSession();
}

function turnLabel() {
  if (bettingPhases.includes(state.phase) && state.currentTurn) return `${seatNames[state.currentTurn]} to act`;
  return phaseLabel(state.phase);
}

function renderSeats() {
  seats.forEach((seat) => {
    const player = state.players[seat];
    const element = els.seats[seat];
    const reveal = shouldRevealSeat(seat);
    element.classList.toggle("active-seat", state.currentTurn === seat && bettingPhases.includes(state.phase));
    element.classList.toggle("folded", player.folded);
    element.classList.toggle("all-in", player.allIn && state.phase !== "complete");
    element.innerHTML = `
      <div class="player-name">${seatNames[seat]}${seat === mySeat ? " (you)" : ""}${seat === state.dealer ? " · Button" : ""}</div>
      <div class="seat-hole">${renderSeatHole(player, reveal)}</div>
      <div class="chip-line"><span class="chip-dot ${seat === "north" ? "blue" : ""}"></span>${player.chips} play chips</div>
      <div class="bet-line">Bet ${player.streetBet} · In pot ${player.committed}${player.allIn ? " · all-in" : ""}${player.folded ? " · folded" : ""}</div>
    `;
  });
}

function shouldRevealSeat(seat) {
  if (seat === mySeat) return true;
  if (state.phase === "complete" && state.showdown && !state.showdown.folded && !state.players[seat].folded) return true;
  return false;
}

function renderSeatHole(player, reveal) {
  return player.hole.map((card) => reveal ? miniCardMarkup(card) : `<span class="card-back" aria-label="Hidden card"></span>`).join("");
}

function renderCommunity() {
  els.communityCards.innerHTML = "";
  for (let i = 0; i < 5; i += 1) {
    const slot = document.createElement("div");
    slot.className = "board-slot";
    if (state.community[i]) slot.innerHTML = holdemCardMarkup(state.community[i]);
    els.communityCards.append(slot);
  }
}

function renderHand() {
  els.hand.innerHTML = "";
  if (!mySeat) {
    els.hand.innerHTML = `<span class="player-meta">Host or join to see your cards.</span>`;
    return;
  }
  state.players[mySeat].hole.forEach((card) => {
    const item = document.createElement("div");
    item.className = `holdem-card ${cardSuitClass(card)}`;
    item.innerHTML = cardMarkup(card);
    els.hand.append(item);
  });
}

function renderActions() {
  els.actionControls.innerHTML = "";
  if (!mySeat) {
    addActionButton("Host or join to play", () => {}, true);
    return;
  }
  if (state.phase === "showdown") {
    addActionButton(typeof Hand === "undefined" ? "Evaluator loading" : "Resolve showdown", () => submitAction({ kind: "resolveShowdown" }), typeof Hand === "undefined");
    return;
  }
  if (state.phase === "complete") {
    addActionButton("Hand complete", () => {}, true);
    return;
  }
  if (!canSeatAct(mySeat)) {
    addActionButton(state.currentTurn ? `Waiting for ${seatNames[state.currentTurn]}` : "No action available", () => {}, true);
    return;
  }

  const toCall = amountToCall(mySeat);
  if (toCall > 0) {
    addActionButton("Fold", () => submitAction({ kind: "betting", seat: mySeat, move: "fold" }));
    addActionButton(`Call ${Math.min(toCall, state.players[mySeat].chips)}`, () => submitAction({ kind: "betting", seat: mySeat, move: "call" }));
  } else {
    addActionButton("Check", () => submitAction({ kind: "betting", seat: mySeat, move: "check" }));
  }

  if (state.players[mySeat].chips > 0) renderRaiseControls();
}

function renderRaiseControls() {
  const player = state.players[mySeat];
  const maxTotal = maxTotalBet(mySeat);
  const minTotal = Math.min(maxTotal, minimumAggressiveTotal());
  const canIncrease = maxTotal > state.currentBet;
  if (!canIncrease) return;

  const group = document.createElement("div");
  group.className = "bet-widget";
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.className = "label";
  caption.textContent = state.currentBet > 0 ? "Raise to" : "Bet";
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(minTotal);
  input.max = String(maxTotal);
  input.step = String(smallBlind);
  input.value = String(minTotal);
  label.append(caption, input);

  const raiseButton = document.createElement("button");
  raiseButton.type = "button";
  raiseButton.textContent = state.currentBet > 0 ? "Raise" : "Bet";
  raiseButton.addEventListener("click", () => {
    submitAction({ kind: "betting", seat: mySeat, move: "raise", total: Number(input.value) });
  });

  const allInButton = document.createElement("button");
  allInButton.type = "button";
  const maxIncrement = maxTotal - player.streetBet;
  const trueAllIn = maxTotal === player.streetBet + player.chips;
  allInButton.textContent = trueAllIn ? `All-in ${player.chips}` : `Max bet ${maxIncrement}`;
  allInButton.addEventListener("click", () => {
    submitAction(trueAllIn
      ? { kind: "betting", seat: mySeat, move: "allIn" }
      : { kind: "betting", seat: mySeat, move: "raise", total: maxTotal });
  });

  group.append(label, raiseButton, allInButton);
  els.actionControls.append(group);
}

function renderShowdown() {
  els.showdownPanel.innerHTML = "";
  els.showdownPanel.classList.toggle("visible", Boolean(state.showdown));
  if (!state.showdown) return;

  seats.forEach((seat) => {
    const item = document.createElement("div");
    const isWinner = state.showdown.winners.includes(seat);
    item.className = `showdown-item ${isWinner ? "winner" : ""}`;
    const hand = state.showdown.hands?.[seat];
    const showCards = !state.showdown.folded || seat === mySeat || !state.players[seat].folded;
    const cards = showCards ? state.players[seat].hole.map(miniCardMarkup).join("") : state.players[seat].hole.map(() => `<span class="card-back" aria-label="Hidden card"></span>`).join("");
    item.innerHTML = `
      <div class="showdown-title"><span>${seatNames[seat]}</span><span>${isWinner ? "Winner" : ""}</span></div>
      <div class="showdown-cards">${cards}</div>
      <div class="showdown-hand">${hand?.description || (state.players[seat].folded ? "Folded" : "No showdown")}</div>
    `;
    els.showdownPanel.append(item);
  });
}

function renderActionLog() {
  els.actionLog.innerHTML = "";
  state.actionLog.forEach((entry) => {
    const item = document.createElement("li");
    item.textContent = entry;
    els.actionLog.append(item);
  });
}

function addActionButton(label, fn, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", fn);
  els.actionControls.append(button);
}

function isRed(card) {
  return card.suit === "H" || card.suit === "D";
}

function cardSuitClass(card) {
  return `suit-${card.suit.toLowerCase()} ${isRed(card) ? "red" : "black"}`;
}

function cardMarkup(card) {
  return `<span class="rank">${card.rank}</span><span class="suit">${suitSymbols[card.suit]}</span>`;
}

function holdemCardMarkup(card) {
  return `<div class="holdem-card ${cardSuitClass(card)}">${cardMarkup(card)}</div>`;
}

function miniCardMarkup(card) {
  return `<span class="mini-card ${cardSuitClass(card)}">${cardMarkup(card)}</span>`;
}

function solverCard(card) {
  return `${card.rank}${card.suit.toLowerCase()}`;
}

function confirmNewHand() {
  const ok = window.confirm("Start a new hand? This will end the current poker hand for both players.");
  if (ok) submitAction({ kind: "newHand" });
}

function confirmNewGame() {
  const ok = window.confirm("Start a new game? This will reset play-chip stacks and the current hand for both players.");
  if (ok) submitAction({ kind: "newGame" });
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
els.newHandBtn.addEventListener("click", confirmNewHand);
els.newGameBtn.addEventListener("click", confirmNewGame);
els.roomInput.addEventListener("input", () => {
  els.roomInput.value = els.roomInput.value.toUpperCase();
  render();
});

if (savedSession?.room) els.roomInput.value = savedSession.room;
render();

fetch(apiUrl("/api/health"), { cache: "no-store" })
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
