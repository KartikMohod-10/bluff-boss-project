import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const clients = new Map();
const connectionHandlers = [];
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const ROUND_MS = 90_000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const id = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

class RealtimeClient {
  constructor(netSocket) {
    this.id = id(10);
    this.data = {};
    this.netSocket = netSocket;
    this.handlers = new Map();
    this.rooms = new Set();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.lastPongAt = Date.now();
    netSocket.on('data', chunk => this.consume(chunk));
    netSocket.on('close', () => this.finish());
    netSocket.on('error', () => this.finish());
  }
  on(event, callback) {
    const list = this.handlers.get(event) || [];
    list.push(callback);
    this.handlers.set(event, list);
    return this;
  }
  emit(event, data) {
    if (this.closed || this.netSocket.destroyed) return;
    const payload = Buffer.from(JSON.stringify({ event, data }));
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    try { this.netSocket.write(Buffer.concat([header, payload])); } catch { this.finish(); }
  }
  join(room) { this.rooms.add(room); }
  leave(room) { this.rooms.delete(room); }
  disconnect(force = false) {
    if (this.closed) return;
    if (force) this.netSocket.destroy();
    else {
      try { this.netSocket.end(Buffer.from([0x88, 0x00])); } catch { this.netSocket.destroy(); }
      setTimeout(() => { if (!this.closed) this.netSocket.destroy(); }, 250).unref();
    }
    this.finish();
  }
  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > 1024n * 1024n) return this.disconnect(true);
        length = Number(longLength); offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (masked && mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 0x8) { this.disconnect(); return; }
      if (opcode === 0x9) { this.sendControlFrame(0xA, payload); continue; }
      if (opcode === 0xA) { this.lastPongAt = Date.now(); continue; }
      if (opcode !== 0x1) continue;
      try {
        const packet = JSON.parse(payload.toString('utf8'));
        if (!packet || typeof packet.event !== 'string') continue;
        const list = this.handlers.get(packet.event) || [];
        for (const callback of list) {
          try { callback(packet.data); } catch (error) { console.error('Realtime event handler error:', error); }
        }
      } catch { /* Ignore malformed client messages. */ }
    }
  }
  sendControlFrame(opcode, payload = Buffer.alloc(0)) {
    if (payload.length > 125 || this.closed) return;
    this.netSocket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    clients.delete(this.id);
    const list = this.handlers.get('disconnect') || [];
    for (const callback of list) {
      try { callback(); } catch (error) { console.error('Disconnect handler error:', error); }
    }
  }
}

const io = {
  on(event, callback) { if (event === 'connection') connectionHandlers.push(callback); },
  sockets: { sockets: clients }
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
};
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'bluff-boss', rooms: rooms.size, connectedSockets: clients.size }));
    return;
  }
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end('Bad request'); return; }
  const target = path.resolve(publicRoot, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (target !== publicRoot && !target.startsWith(`${publicRoot}${path.sep}`)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(target, (statErr, stats) => {
    const actual = !statErr && stats.isDirectory() ? path.join(target, 'index.html') : target;
    fs.readFile(actual, (err, bytes) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(actual).toLowerCase()] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Cache-Control': 'no-cache'
      });
      res.end(bytes);
    });
  });
});

server.on('upgrade', (request, netSocket, head) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  const key = request.headers['sec-websocket-key'];
  if (pathname !== '/ws' || String(request.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    netSocket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); netSocket.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  netSocket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = new RealtimeClient(netSocket);
  clients.set(client.id, client);
  for (const callback of connectionHandlers) {
    try { callback(client); } catch (error) { console.error('Connection handler error:', error); }
  }
  if (head?.length) client.consume(head);
});

const questionBank = [
  { type: 'fact', category: 'ODD FACTS', title: 'The three-heart mystery', prompt: 'Which animal has three hearts?', truth: 'Octopus', hint: 'One of these creatures has a surprisingly complex circulatory system.' },
  { type: 'story', category: 'YOUR TURN TO BLUFF', title: 'The unbelievable moment', prompt: 'Tell a short story about something unbelievable that happened to you — or invent a story that sounds completely real.', hint: 'Keep it short, specific, and convincing.' },
  { type: 'trick', category: 'SPACE BRAIN', title: 'A day longer than a year', prompt: 'Which planet takes longer to rotate once than it takes to orbit the Sun?', truth: 'Venus', hint: 'Think about a planet with an extremely slow rotation.' },
  { type: 'fact', category: 'WEIRD BUT TRUE', title: 'The forever food', prompt: 'Which food can remain edible for an exceptionally long time when stored properly?', truth: 'Honey', hint: 'Bees make it, and it has a very low water content.' },
  { type: 'story', category: 'YOUR TURN TO BLUFF', title: 'The lucky escape', prompt: 'Share a short story about a surprising coincidence or lucky escape. Make it true or fake — your choice.', hint: 'The more believable details, the better.' },
  { type: 'trick', category: 'ANIMAL KINGDOM', title: 'The only true flyer', prompt: 'Which mammal is capable of powered, sustained flight?', truth: 'Bat', hint: 'A flying squirrel glides; this mammal actually flies.' },
  { type: 'trick', category: 'MIXED CHALLENGE', title: 'A flamboyant crowd', prompt: 'What is a real collective noun for a group of flamingos?', truth: 'A flamboyance', hint: 'The real answer is a delightfully dramatic word.' },
  { type: 'final', category: 'FINAL BOSS', title: 'The fingerprint mystery', prompt: 'Which animal is famous for fingerprints that closely resemble human fingerprints?', truth: 'Koala', hint: 'This tree-dwelling Australian marsupial is the answer.' }
];

const cleanName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 18);
const cleanText = (value, max = 220) => String(value ?? '').trim().replace(/[<>]/g, '').slice(0, max);
const roomCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''); }
  while (rooms.has(code));
  return code;
};
const emitError = (socket, message) => socket.emit('game:error', { message });
const active = (room) => [...room.players.values()].filter(p => p.lives > 0);
const connected = (room) => [...room.players.values()].filter(p => p.connected);

function roomForSocket(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}
function playerForSocket(socket, room) {
  return room?.players.get(socket.data.playerId) ?? null;
}
function isHost(room, player) { return !!room && !!player && room.hostId === player.id; }
function emitSnapshot(room) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.roomCode === room.code && socket.data.playerId) {
      const player = room.players.get(socket.data.playerId);
      if (player) socket.emit('room:state', publicSnapshot(room, player.id));
    }
  }
}
function publicSnapshot(room, viewerId) {
  const viewer = room.players.get(viewerId);
  const game = room.game;
  const snapshot = {
    code: room.code,
    status: game ? game.status : 'lobby',
    hostId: room.hostId,
    viewerId,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, lives: p.lives, bluffPoints: p.bluffPoints,
      connected: p.connected, ready: p.ready, eliminated: p.lives <= 0,
      isHost: p.id === room.hostId
    })),
    canStart: !game && isHost(room, viewer) && connected(room).length >= MIN_PLAYERS && connected(room).every(p => p.ready),
    isHost: isHost(room, viewer),
    game: null
  };
  if (!game) return snapshot;
  const round = game.round;
  const completedRounds = game.roundIndex;
  const phase = round.phase;
  const current = {
    roundNumber: game.roundIndex + 1,
    totalRounds: questionBank.length,
    type: round.spec.type,
    category: round.spec.category,
    title: round.spec.title,
    prompt: round.spec.prompt,
    hint: phase === 'results' || game.status === 'ended' ? round.spec.hint : null,
    phase,
    timeLeftMs: Math.max(0, (round.deadline || 0) - Date.now()),
    submittedCount: Object.keys(round.submissions).length,
    submitterCount: round.spec.type === 'story' ? 1 : round.participants.length,
    votedCount: Object.keys(round.votes).length,
    voterCount: round.voters.length,
    storytellerId: round.storytellerId || null,
    storytellerName: round.storytellerId ? room.players.get(round.storytellerId)?.name || 'Disconnected player' : null,
    mySubmission: round.submissions[viewerId] ? { ...round.submissions[viewerId] } : null,
    myVote: round.votes[viewerId] ?? null,
    myTurnToTellStory: round.storytellerId === viewerId,
    storyTruth: round.storytellerId === viewerId && round.submissions[viewerId] ? round.submissions[viewerId].truth : null,
    options: [],
    results: null,
    isLastRound: game.roundIndex === questionBank.length - 1,
    roundScores: null
  };
  if ((phase === 'vote') && ['fact', 'trick', 'final'].includes(round.spec.type)) {
    const own = round.submissions[viewerId];
    current.options = round.cards.filter(c => c.authorId !== viewerId).map(c => ({ id: c.id, text: c.text }));
    current.hasSubmitted = !!own;
  }
  if (phase === 'results' || game.status === 'ended') {
    current.results = {
      correctCardId: round.correctCardId || null,
      truth: round.spec.truth || null,
      cards: round.cards.map(c => ({ id: c.id, text: c.text, authorId: c.authorId, authorName: c.authorId ? room.players.get(c.authorId)?.name || 'Player' : 'The truth', isTruth: c.id === round.correctCardId })),
      submissions: Object.entries(round.submissions).map(([pid, s]) => ({ playerId: pid, playerName: room.players.get(pid)?.name || 'Player', text: s.text, truth: s.truth ?? null })),
      votes: Object.entries(round.votes).map(([pid, v]) => ({ playerId: pid, playerName: room.players.get(pid)?.name || 'Player', vote: v, correct: round.spec.type === 'story' ? v === (round.submissions[round.storytellerId]?.truth ? 'true' : 'fake') : v === round.correctCardId, targetName: round.spec.type === 'story' ? room.players.get(round.storytellerId)?.name : round.cards.find(c => c.id === v)?.authorId ? room.players.get(round.cards.find(c => c.id === v).authorId)?.name : 'The true answer' })),
      pointChanges: round.pointChanges || {},
      lifeChanges: round.lifeChanges || {},
      storytellerTruth: round.storytellerId ? round.submissions[round.storytellerId]?.truth : null
    };
    current.roundScores = [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, lives: p.lives, bluffPoints: p.bluffPoints, eliminated: p.lives <= 0 })).sort((a,b) => b.score - a.score || b.lives - a.lives || b.bluffPoints - a.bluffPoints);
  }
  snapshot.game = current;
  snapshot.status = game.status;
  return snapshot;
}

function clearRoundTimer(room) {
  if (room.game?.round?.timer) clearTimeout(room.game.round.timer);
  if (room.game?.round) room.game.round.timer = null;
}
function setRoundTimer(room, phase) {
  clearRoundTimer(room);
  if (!room.game || room.game.status !== 'playing') return;
  room.game.round.deadline = Date.now() + ROUND_MS;
  room.game.round.timer = setTimeout(() => onPhaseTimeout(room.code, phase), ROUND_MS);
}
function chooseStoryteller(room) {
  const game = room.game;
  const roster = game.turnOrder;
  if (!roster.length) return null;
  for (let step = 0; step < roster.length; step++) {
    const index = (game.storyCursor + step) % roster.length;
    const pid = roster[index];
    const p = room.players.get(pid);
    if (p && p.lives > 0 && p.connected) {
      game.storyCursor = (index + 1) % roster.length;
      return pid;
    }
  }
  return null;
}
function makeRound(room, index) {
  const spec = questionBank[index];
  const participants = active(room).filter(p => p.connected).map(p => p.id);
  const round = {
    spec, phase: 'submit', participants,
    voters: [], submissions: {}, votes: {}, cards: [], correctCardId: null,
    storytellerId: null, pointChanges: {}, lifeChanges: {}, deadline: null, timer: null
  };
  if (spec.type === 'story') {
    round.storytellerId = chooseStoryteller(room);
    if (!round.storytellerId) {
      round.phase = 'results';
      round.spec = { ...spec, hint: 'No connected storyteller was available.' };
      return round;
    }
    round.voters = participants.filter(pid => pid !== round.storytellerId);
  } else {
    round.voters = participants.slice();
  }
  return round;
}
function beginGame(room) {
  for (const p of room.players.values()) { p.score = 0; p.bluffPoints = 0; p.lives = 3; p.ready = true; }
  room.game = { status: 'playing', roundIndex: 0, turnOrder: [...room.players.keys()], storyCursor: 0, round: null, winnerId: null };
  room.game.round = makeRound(room, 0);
  if (room.game.round.phase === 'submit') setRoundTimer(room, 'submit');
  emitSnapshot(room);
}
function enterVotePhase(room) {
  const game = room.game;
  const round = game.round;
  clearRoundTimer(room);
  round.phase = 'vote';
  if (['fact', 'trick', 'final'].includes(round.spec.type)) {
    round.correctCardId = id(5);
    round.cards = [{ id: round.correctCardId, text: round.spec.truth, authorId: null }];
    for (const pid of round.participants) {
      const sub = round.submissions[pid];
      if (sub && !sub.missed) round.cards.push({ id: id(5), text: sub.text, authorId: pid });
    }
    for (let i = round.cards.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1); [round.cards[i], round.cards[j]] = [round.cards[j], round.cards[i]];
    }
  }
  setRoundTimer(room, 'vote');
  emitSnapshot(room);
  if (round.voters.length === 0) settleRound(room);
}
function applyChange(changes, playerId, amount) { changes[playerId] = (changes[playerId] || 0) + amount; }
function settleRound(room, timedOut = false) {
  const game = room.game;
  if (!game || game.status !== 'playing') return;
  const round = game.round;
  if (round.phase === 'results') return;
  clearRoundTimer(room);
  const pointChanges = {};
  const lifeChanges = {};
  const tally = (pid, points, successfulBluff = false) => {
    const p = room.players.get(pid); if (!p) return;
    p.score += points;
    if (successfulBluff) p.bluffPoints += points;
    applyChange(pointChanges, pid, points);
  };
  const loseLife = (pid) => {
    const p = room.players.get(pid); if (!p || p.lives <= 0) return;
    p.lives -= 1; applyChange(lifeChanges, pid, -1);
  };
  if (['fact', 'trick', 'final'].includes(round.spec.type)) {
    for (const pid of round.voters) {
      const picked = round.votes[pid];
      if (!picked) { if (timedOut) loseLife(pid); continue; }
      if (picked === round.correctCardId) tally(pid, 2);
      else {
        loseLife(pid);
        const fake = round.cards.find(c => c.id === picked);
        if (fake?.authorId && fake.authorId !== pid) tally(fake.authorId, 2, true);
      }
    }
  } else if (round.spec.type === 'story') {
    const story = round.submissions[round.storytellerId];
    if (story?.missed) {
      loseLife(round.storytellerId);
    } else if (story) {
      for (const pid of round.voters) {
        const picked = round.votes[pid];
        if (!picked) { if (timedOut) loseLife(pid); continue; }
        const correctChoice = story.truth ? 'true' : 'fake';
        if (picked === correctChoice) tally(pid, 2);
        else { loseLife(pid); tally(round.storytellerId, 2, true); }
      }
    }
  }
  round.pointChanges = pointChanges;
  round.lifeChanges = lifeChanges;
  round.phase = 'results';
  round.deadline = null;
  const remaining = active(room).filter(p => p.connected);
  if (remaining.length <= 1 || game.roundIndex >= questionBank.length - 1) {
    game.status = 'ended';
    game.winnerId = [...room.players.values()].sort((a,b) => b.score - a.score || b.lives - a.lives || b.bluffPoints - a.bluffPoints)[0]?.id || null;
    round.phase = 'results';
  }
  emitSnapshot(room);
}
function onPhaseTimeout(code, expectedPhase) {
  const room = rooms.get(code);
  if (!room?.game || room.game.status !== 'playing') return;
  const round = room.game.round;
  if (round.phase !== expectedPhase) return;
  if (expectedPhase === 'submit') {
    if (round.spec.type === 'story') {
      // A silent storyteller is treated as a missed turn and the round is skipped safely.
      if (!round.submissions[round.storytellerId]) {
        round.submissions[round.storytellerId] = { text: '(No story submitted)', truth: false, missed: true };
        round.cards = [];
        round.voters = [];
        enterVotePhase(room);
      }
    } else {
      for (const pid of round.participants) {
        if (!round.submissions[pid]) round.submissions[pid] = { text: '(No bluff submitted)', missed: true };
      }
      enterVotePhase(room);
    }
  } else if (expectedPhase === 'vote') {
    settleRound(room, true);
  }
}
function currentRoomAndPlayer(socket) {
  const room = roomForSocket(socket);
  const player = playerForSocket(socket, room);
  if (!room || !player) { emitError(socket, 'You are not in a room. Create one or join with a room code.'); return {}; }
  return { room, player };
}
function releaseSocketMembership(socket) {
  socket.data.roomCode = null;
  socket.data.playerId = null;
}

io.on('connection', (socket) => {
  socket.emit('server:hello', { version: '1.0.0' });

  socket.on('room:create', ({ name } = {}) => {
    const safeName = cleanName(name);
    if (!safeName) return emitError(socket, 'Enter a display name first.');
    if (socket.data.roomCode) return emitError(socket, 'Leave your current room before creating another.');
    const code = roomCode();
    const playerId = id(10);
    const token = id(20);
    const player = { id: playerId, token, name: safeName, score: 0, bluffPoints: 0, lives: 3, ready: true, connected: true, socketId: socket.id, joinedAt: Date.now() };
    const room = { code, hostId: playerId, players: new Map([[playerId, player]]), game: null, createdAt: Date.now(), updatedAt: Date.now() };
    rooms.set(code, room);
    socket.join(code); socket.data.roomCode = code; socket.data.playerId = playerId;
    socket.emit('room:created', { code, token, playerId });
    emitSnapshot(room);
  });

  socket.on('room:join', ({ code, name } = {}) => {
    const safeCode = String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const safeName = cleanName(name);
    if (!safeName) return emitError(socket, 'Enter a display name first.');
    if (socket.data.roomCode) return emitError(socket, 'Leave your current room before joining another.');
    const room = rooms.get(safeCode);
    if (!room) return emitError(socket, 'Room not found. Check the code and try again.');
    if (room.game) return emitError(socket, 'This game has already started. Ask the host to create a new room.');
    if (room.players.size >= MAX_PLAYERS) return emitError(socket, 'This room is full (8 players maximum).');
    if ([...room.players.values()].some(p => p.name.toLowerCase() === safeName.toLowerCase())) return emitError(socket, 'That display name is already in use in this room.');
    const playerId = id(10); const token = id(20);
    const player = { id: playerId, token, name: safeName, score: 0, bluffPoints: 0, lives: 3, ready: false, connected: true, socketId: socket.id, joinedAt: Date.now() };
    room.players.set(playerId, player); room.updatedAt = Date.now();
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.playerId = playerId;
    socket.emit('room:joined', { code: room.code, token, playerId });
    emitSnapshot(room);
  });

  socket.on('room:rejoin', ({ code, token } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room && [...room.players.values()].find(p => p.token === token);
    if (!room || !player) return emitError(socket, 'That saved session is no longer available. Join an open room or create a new one.');
    if (player.socketId && player.socketId !== socket.id) {
      const previous = io.sockets.sockets.get(player.socketId);
      if (previous) { previous.data.roomCode = null; previous.data.playerId = null; previous.leave(room.code); }
    }
    player.connected = true; player.socketId = socket.id;
    if (!room.game) player.ready = true;
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.playerId = player.id;
    room.updatedAt = Date.now();
    socket.emit('room:rejoined', { code: room.code, token: player.token, playerId: player.id });
    emitSnapshot(room);
  });

  socket.on('player:ready', ({ ready } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket); if (!room || room.game) return;
    player.ready = !!ready; room.updatedAt = Date.now(); emitSnapshot(room);
  });

  socket.on('game:start', () => {
    const { room, player } = currentRoomAndPlayer(socket); if (!room) return;
    if (!isHost(room, player)) return emitError(socket, 'Only the host can start the game.');
    if (room.game) return emitError(socket, 'This game has already started.');
    if (connected(room).length < MIN_PLAYERS) return emitError(socket, 'You need at least 2 connected players to start.');
    if (!connected(room).every(p => p.ready)) return emitError(socket, 'Everyone must be ready before the game starts.');
    beginGame(room); room.updatedAt = Date.now();
  });

  socket.on('round:submit', ({ text, truth } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket); if (!room?.game || room.game.status !== 'playing') return;
    const round = room.game.round;
    if (round.phase !== 'submit') return emitError(socket, 'Answer submissions are closed for this round.');
    if (!round.participants.includes(player.id) || player.lives <= 0) return emitError(socket, 'You are not active in this round.');
    if (round.submissions[player.id]) return emitError(socket, 'Your answer has already been submitted.');
    if (round.spec.type === 'story' && round.storytellerId !== player.id) return emitError(socket, 'Only the selected storyteller submits a story this round.');
    const safeText = cleanText(text, 220);
    if (safeText.length < 3) return emitError(socket, 'Enter at least 3 characters.');
    const submission = { text: safeText };
    if (round.spec.type === 'story') {
      if (typeof truth !== 'boolean') return emitError(socket, 'Choose whether your story is true or a bluff.');
      submission.truth = truth;
    }
    round.submissions[player.id] = submission;
    room.updatedAt = Date.now();
    const allSubmitted = round.spec.type === 'story'
      ? !!round.submissions[round.storytellerId]
      : round.participants.every(pid => !!round.submissions[pid]);
    if (allSubmitted) enterVotePhase(room); else emitSnapshot(room);
  });

  socket.on('round:vote', ({ choice } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket); if (!room?.game || room.game.status !== 'playing') return;
    const round = room.game.round;
    if (round.phase !== 'vote') return emitError(socket, 'Voting is not open right now.');
    if (!round.voters.includes(player.id) || player.lives <= 0) return emitError(socket, 'You cannot vote in this round.');
    if (round.votes[player.id] !== undefined) return emitError(socket, 'Your vote has already been recorded.');
    if (round.spec.type === 'story') {
      if (!['true', 'fake'].includes(choice)) return emitError(socket, 'Choose TRUE or BLUFF.');
    } else {
      const allowed = round.cards.filter(c => c.authorId !== player.id).some(c => c.id === choice);
      if (!allowed) return emitError(socket, 'Choose an answer other than your own bluff.');
    }
    round.votes[player.id] = choice;
    room.updatedAt = Date.now();
    if (round.voters.every(pid => round.votes[pid] !== undefined)) settleRound(room); else emitSnapshot(room);
  });

  socket.on('game:next-round', () => {
    const { room, player } = currentRoomAndPlayer(socket); if (!room?.game) return;
    if (!isHost(room, player)) return emitError(socket, 'Only the host can advance the game.');
    if (room.game.status !== 'playing' || room.game.round.phase !== 'results') return emitError(socket, 'The round is not ready to advance.');
    if (room.game.roundIndex >= questionBank.length - 1) return emitError(socket, 'The game is already complete.');
    room.game.roundIndex += 1;
    room.game.round = makeRound(room, room.game.roundIndex);
    if (room.game.round.phase === 'submit') setRoundTimer(room, 'submit');
    room.updatedAt = Date.now(); emitSnapshot(room);
    if (room.game.round.phase === 'results') settleRound(room);
  });

  socket.on('game:rematch', () => {
    const { room, player } = currentRoomAndPlayer(socket); if (!room?.game) return;
    if (!isHost(room, player)) return emitError(socket, 'Only the host can start a rematch.');
    if (room.game.status !== 'ended') return emitError(socket, 'Finish the current game before starting a rematch.');
    if (connected(room).length < MIN_PLAYERS) return emitError(socket, 'At least two connected players are needed for a rematch.');
    for (const p of room.players.values()) if (p.connected) p.ready = true;
    beginGame(room); room.updatedAt = Date.now();
  });

  socket.on('room:leave', () => {
    const { room, player } = currentRoomAndPlayer(socket); if (!room) return;
    const isLobby = !room.game;
    player.connected = false;
    if (isLobby) room.players.delete(player.id);
    if (room.hostId === player.id) {
      const nextHost = connected(room)[0];
      if (nextHost) room.hostId = nextHost.id;
    }
    socket.leave(room.code); releaseSocketMembership(socket);
    if (room.players.size === 0) { clearRoundTimer(room); rooms.delete(room.code); }
    else emitSnapshot(room);
  });

  socket.on('disconnect', () => {
    const room = roomForSocket(socket); const player = playerForSocket(socket, room);
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    if (room.hostId === player.id) {
      const nextHost = connected(room)[0];
      if (nextHost) room.hostId = nextHost.id;
    }
    room.updatedAt = Date.now(); emitSnapshot(room);
  });
});

// Clean up abandoned rooms so this simple deployment stays small.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS) {
      clearRoundTimer(room); rooms.delete(code);
      for (const socket of io.sockets.sockets.values()) if (socket.data.roomCode === code) socket.disconnect(true);
    }
  }
}, 10 * 60 * 1000).unref();

setInterval(() => {
  const now = Date.now();
  for (const client of clients.values()) {
    if (now - client.lastPongAt > 75_000) client.disconnect(true);
    else client.sendControlFrame(0x9, crypto.randomBytes(4));
  }
}, 25_000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`BLUFF BOSS listening on port ${PORT}`));
