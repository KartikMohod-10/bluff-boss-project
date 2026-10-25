(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const socket = createRealtimeSocket();
  function createRealtimeSocket() {
    const listeners = new Map();
    let ws = null;
    let retry = 0;
    let manual = false;
    function dispatch(event, data) {
      for (const callback of (listeners.get(event) || [])) {
        try { callback(data); } catch (error) { console.error(error); }
      }
    }
    function connect() {
      if (manual) return;
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${scheme}//${location.host}/ws`);
      ws.addEventListener('open', () => { retry = 0; dispatch('connect'); });
      ws.addEventListener('message', event => {
        try { const packet = JSON.parse(event.data); if (packet && typeof packet.event === 'string') dispatch(packet.event, packet.data); }
        catch { /* Ignore malformed server frames. */ }
      });
      ws.addEventListener('close', () => {
        dispatch('disconnect');
        if (!manual) {
          const delay = Math.min(15000, 500 * (2 ** Math.min(retry, 5)));
          retry++;
          setTimeout(connect, delay);
        }
      });
      ws.addEventListener('error', () => { try { ws.close(); } catch {} });
    }
    connect();
    return {
      on(event, callback) { const list = listeners.get(event) || []; list.push(callback); listeners.set(event, list); return this; },
      emit(event, data) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data }));
      },
      disconnect() { manual = true; if (ws) ws.close(); }
    };
  }

  const sessionKey = 'bluff-boss-session-v1';
  let session = loadSession();
  let state = null;
  let truthChoice = null;
  let reconnectAttempt = false;
  let lastConnectionState = true;
  let toastTimer = null;
  let countdownInterval = null;

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(sessionKey) || 'null'); } catch { return null; }
  }
  function saveSession(value) {
    session = value;
    if (value) localStorage.setItem(sessionKey, JSON.stringify(value));
    else localStorage.removeItem(sessionKey);
  }
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0,2).map(s => s[0] || '').join('').toUpperCase(); }
  function avatarClass(index) { return ['','orange','cyan','pink'][index % 4]; }
  function toast(message, kind = '') {
    const region = $('#toast-region');
    const node = document.createElement('div'); node.className = `toast ${kind}`; node.textContent = message;
    region.appendChild(node);
    setTimeout(() => { node.style.opacity = '0'; node.style.transform = 'translateY(6px)'; setTimeout(() => node.remove(), 220); }, 3600);
  }
  function setConnection(connected) {
    lastConnectionState = connected;
    let banner = $('#connection-banner');
    if (!banner) {
      banner = document.createElement('div'); banner.id = 'connection-banner'; banner.className = 'connection-banner';
      $('#app').prepend(banner);
    }
    banner.textContent = connected ? 'Connection restored. Syncing your room…' : 'Connection lost — trying to reconnect…';
    banner.classList.toggle('visible', !connected || !!state);
    if (connected && !state) setTimeout(() => banner.classList.remove('visible'), 1600);
  }
  function goHome() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = null;
    state = null; truthChoice = null; saveSession(null);
    $('#home-screen').classList.remove('hidden'); $('#room-screen').classList.add('hidden'); $('#game-screen').classList.add('hidden');
    $('#leave-top').classList.add('hidden');
    $('#connection-banner')?.classList.remove('visible');
  }
  function setNameFromSession() {
    if (session?.name) $('#player-name').value = session.name;
  }

  socket.on('connect', () => {
    setConnection(true);
    if (session?.code && session?.token) {
      reconnectAttempt = true;
      socket.emit('room:rejoin', { code: session.code, token: session.token });
    }
  });
  socket.on('disconnect', () => setConnection(false));
  socket.on('room:created', data => {
    reconnectAttempt = false;
    saveSession({ ...data, name: cleanNameFromInput() });
    toast(`Room ${data.code} is ready. Invite your crew!`, 'success');
  });
  socket.on('room:joined', data => {
    reconnectAttempt = false;
    saveSession({ ...data, name: cleanNameFromInput() });
    toast(`You're in room ${data.code}.`, 'success');
  });
  socket.on('room:rejoined', data => {
    reconnectAttempt = false;
    if (session) saveSession({ ...session, ...data });
    toast('Back in the room — your game is synced.', 'success');
  });
  socket.on('room:state', next => {
    const oldRound = state?.game?.roundNumber ?? null;
    const oldPhase = state?.game?.phase ?? null;
    const newRound = next?.game?.roundNumber ?? null;
    const newPhase = next?.game?.phase ?? null;
    if (oldRound !== newRound || oldPhase !== newPhase) truthChoice = null;
    state = next;
    if (session && next?.code) saveSession({ ...session, code: next.code, playerId: next.viewerId });
    render();
  });
  socket.on('game:error', data => {
    toast(data?.message || 'Something went wrong. Try again.', 'error');
    if (reconnectAttempt) {
      reconnectAttempt = false;
      saveSession(null);
      $('#room-code').value = new URLSearchParams(location.search).get('room') || '';
      setNameFromSession();
    }
  });

  function cleanNameFromInput() { return String($('#player-name')?.value || session?.name || '').trim().slice(0,18); }
  function currentPlayer() { return state?.players?.find(p => p.id === state.viewerId); }
  function playerById(id) { return state?.players?.find(p => p.id === id); }
  function render() {
    const activeElement = document.activeElement;
    const draft = activeElement?.id === 'answer-text' ? activeElement.value : null;
    const cursorStart = activeElement?.id === 'answer-text' ? activeElement.selectionStart : null;
    const cursorEnd = activeElement?.id === 'answer-text' ? activeElement.selectionEnd : null;
    $('#home-screen').classList.toggle('hidden', !!state);
    $('#room-screen').classList.toggle('hidden', !state || state.status !== 'lobby');
    $('#game-screen').classList.toggle('hidden', !state || state.status === 'lobby');
    $('#leave-top').classList.toggle('hidden', !state);
    if (!state) return;
    if (state.status === 'lobby') renderLobby(); else renderGame();
    if (draft !== null) {
      const restored = $('#answer-text');
      if (restored) { restored.value = draft; restored.focus({ preventScroll: true }); if (cursorStart !== null && cursorEnd !== null) restored.setSelectionRange(cursorStart, cursorEnd); const count = $('#char-count'); if (count) count.textContent = String(draft.length); }
    }
  }

  function playerRow(player, index) {
    const role = player.isHost ? '<span class="status-chip">HOST</span>' : player.connected ? `<span class="status-chip ${player.ready ? 'ready' : ''}">${player.ready ? 'READY' : 'NOT READY'}</span>` : '<span class="status-chip offline">OFFLINE</span>';
    return `<div class="player-row"><div class="avatar ${avatarClass(index)}">${esc(initials(player.name))}</div><div class="player-meta"><div class="player-name">${esc(player.name)}${player.id === state.viewerId ? ' <span class="muted">(you)</span>' : ''}</div><div class="player-sub">${player.connected ? (player.isHost ? 'Calling the shots' : 'In the room') : 'Reconnecting…'}</div></div>${role}</div>`;
  }
  function renderLobby() {
    const me = currentPlayer();
    const roomLink = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.code)}`;
    const count = state.players.length;
    const canStart = state.canStart;
    $('#room-screen').innerHTML = `
      <div class="section-kicker">ROOM LOBBY / WAITING FOR YOUR CREW</div>
      <h1 class="page-title">The bluff room is open.</h1>
      <p class="page-subtitle">Send the code to your friends. The more suspicious, the better.</p>
      <div class="lobby-layout">
        <div class="panel">
          <div class="panel-title-row"><h2 class="panel-title">Your crew</h2><span class="subtle-count">${count} / 8 PLAYERS</span></div>
          <div class="player-list">${state.players.map(playerRow).join('')}</div>
          <div style="height:16px"></div>
          ${!me?.ready ? `<button class="button button-primary button-full" data-action="ready">I'm ready — let's play <span>✦</span></button>` : `<button class="button button-secondary button-full" data-action="unready">You're ready ✓ <span>·</span> Click to change</button>`}
          <p class="lobby-hint" style="margin-top:12px">Everyone who's connected must be ready before the host starts.</p>
        </div>
        <aside class="lobby-aside">
          <div class="panel">
            <div class="panel-title-row"><h2 class="panel-title">Room code</h2><span class="status-chip ready">LIVE</span></div>
            <div class="room-code-box"><strong class="room-code">${esc(state.code)}</strong><button class="copy-button" data-action="copy-code">Copy code ↗</button></div>
            <label for="share-link">INVITE LINK</label>
            <div class="link-row"><input id="share-link" value="${esc(roomLink)}" readonly /><button class="copy-button" data-action="copy-link">Copy</button></div>
            <p class="small-note">Friends can join from any phone or laptop. No login. No download.</p>
          </div>
          <div class="lobby-game-card"><h3>BLUFF BOSS</h3><p>Eight rounds of weird facts, unbelievable stories, and dangerously convincing lies.</p><div class="rules-chips"><span>8 ROUNDS</span><span>3 LIVES</span><span>+2 POINTS</span><span>2–8 PLAYERS</span></div></div>
          <div class="lobby-actions">${state.isHost ? `<button class="button button-primary button-full" data-action="start" ${canStart ? '' : 'disabled'}>Start the game <span>→</span></button>` : `<div class="waiting-card"><div class="waiting-icon">◌</div><h3>Waiting for the host</h3><p>The host can start when at least two players are ready.</p></div>`}${state.isHost && !canStart ? `<p class="lobby-hint">${count < 2 ? 'Invite at least one more player.' : 'Waiting for every connected player to get ready.'}</p>` : ''}</div>
        </aside>
      </div>`;
  }

  function heartBar(lives) { return `<div class="life-icons">${[0,1,2].map(i => `<span class="life-heart ${i >= lives ? 'off' : ''}">♥</span>`).join('')}</div>`; }
  function scoreRow(p, index) {
    const rank = index === 0 ? '✦' : String(index + 1).padStart(2,'0');
    return `<div class="score-row"><span class="score-rank">${rank}</span><div class="score-avatar" style="background:${index===0?'linear-gradient(145deg,#ffc77e,#f59a65)':index===1?'linear-gradient(145deg,#bca6ff,#8f6aff)':index===2?'linear-gradient(145deg,#84f1e8,#3caaa9)':'#34304b'}">${esc(initials(p.name))}</div><div class="score-info"><div class="score-name">${esc(p.name)}${p.id===state.viewerId?' (you)':''}${p.eliminated?' · OUT':''}</div><div class="score-meta">${p.eliminated?'Eliminated':`${p.lives} ${p.lives===1?'life':'lives'}`}</div>${heartBar(p.lives)}</div><span class="score-points">${p.score}</span></div>`;
  }
  function phaseName(phase) { return ({ submit:'YOUR MOVE', vote:'MAKE YOUR CALL', results:'THE REVEAL' })[phase] || phase.toUpperCase(); }
  function safeProgress(n) { return Math.max(0, Math.min(100, n / 8 * 100)); }
  function formatTimer(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
  }
  function startRoundCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    const timer = $('#round-timer');
    if (!timer) return;
    const deadline = Number(timer.dataset.deadline || Date.now());
    const tick = () => { timer.textContent = formatTimer(deadline - Date.now()); };
    tick(); countdownInterval = setInterval(tick, 250);
  }
  function renderGame() {
    const g = state.game;
    if (!g) return;
    const me = currentPlayer();
    const ranked = [...state.players].sort((a,b)=>b.score-a.score || b.lives-a.lives || b.bluffPoints-a.bluffPoints);
    let body = '';
    if (g.phase === 'submit') body = renderSubmit(g, me);
    else if (g.phase === 'vote') body = renderVote(g, me);
    else body = renderResults(g);
    const statusText = g.phase === 'submit' ? `${g.submittedCount} / ${g.submitterCount} answers in` : g.phase === 'vote' ? `${g.votedCount} / ${g.voterCount} votes in` : 'Round results';
    const winnerPlayer = state.status === 'ended' ? ranked[0] : null;
    $('#game-screen').innerHTML = `
      <div class="game-header"><div><div class="section-kicker">BLUFF BOSS / ROUND ${g.roundNumber}</div><h1 class="page-title">${state.status === 'ended' ? 'Game. Set. BLUFF.' : esc(g.title)}</h1><p class="page-subtitle">${state.status === 'ended' ? 'The room has spoken. Here are the final standings.' : esc(statusText)} · ${esc(g.category)}</p></div><div class="round-chip">ROUND ${g.roundNumber} <span style="color:#8172b4">/</span> 08</div></div>
      ${winnerPlayer ? `<div class="winner-card"><div class="winner-crown">♛</div><h2>${esc(winnerPlayer.name)} <strong>WINS!</strong></h2><p>Ultimate Bluff Boss with <strong>${winnerPlayer.score} points</strong> and ${winnerPlayer.lives} ${winnerPlayer.lives===1?'life':'lives'} remaining.</p></div>` : ''}
      <div class="game-layout"><div class="panel main-game-card"><div class="round-progress"><span style="width:${safeProgress(g.roundNumber)}%"></span></div><div class="round-topline"><span class="category-chip">✦ ${esc(g.category)}</span><span class="phase-chip">${esc(phaseName(g.phase))}${['submit','vote'].includes(g.phase) ? ` <span class="timer-text" id="round-timer" data-deadline="${Date.now()+g.timeLeftMs}">${formatTimer(g.timeLeftMs)}</span>` : ''}</span></div><h2 class="question-title">${esc(g.title)}</h2><p class="question-prompt">${esc(g.prompt)}</p>${body}</div>
      <aside class="side-panel"><div class="side-box"><div class="side-heading"><h3>LEADERBOARD</h3><span>LIVE SCORES</span></div><div class="score-list">${ranked.map(scoreRow).join('')}</div></div><div class="side-box"><div class="side-heading"><h3>GAME STATS</h3><span>RULES</span></div><div class="rule-mini"><div><strong>+2</strong><span>Per correct call</span></div><div><strong>−1 ♥</strong><span>Wrong vote</span></div><div><strong>3 ♥</strong><span>Starting lives</span></div><div><strong>8</strong><span>Total rounds</span></div></div><p class="status-line">${g.phase==='submit'?'Keep it believable. Answers stay secret until everyone submits.':g.phase==='vote'?'Read carefully. Your vote is final — and costs a life if it is wrong.':'The reveal is in. Check who fooled whom.'}</p></div></aside></div>`;
    startRoundCountdown();
  }
  function renderSubmit(g, me) {
    const isStory = g.type === 'story';
    if (me?.eliminated) return `<div class="waiting-card"><div class="waiting-icon">♡</div><h3>You're out — stay for the reveal.</h3><p>Your lives are gone, but your points stay on the board. You can watch the remaining rounds and see who claims the crown.</p></div>`;
    if (isStory && !g.myTurnToTellStory) return `<div class="waiting-card"><div class="waiting-icon">◌</div><h3>${esc(g.storytellerName || 'The storyteller')} has the floor</h3><p>They're preparing a story. You will vote TRUE or BLUFF once they submit it.</p><div class="submitted-list"><div class="submitted-row"><span>Storyteller</span><span>${esc(g.storytellerName || 'Player')}</span></div></div></div>`;
    if (g.mySubmission) return `<div class="waiting-card"><div class="waiting-icon">✦</div><h3>Bluff locked in.</h3><p>Your answer is private. Waiting for the rest of the crew to submit before voting opens.</p><div class="submitted-list"><div class="submitted-row"><span>Your answer</span><span class="dots">•••••••</span></div><div class="submitted-row"><span>Answers submitted</span><strong>${g.submittedCount} / ${g.submitterCount}</strong></div></div></div>`;
    const clue = isStory ? 'You are the storyteller. Write a short story and secretly decide whether it is true or a bluff.' : 'Invent a believable alternative. Other players will choose which answer they think is true. Your own answer cannot be selected by you.';
    return `<div class="instruction-box"><strong>MISSION:</strong> ${esc(clue)}</div><form id="submit-form"><textarea id="answer-text" class="answer-textarea" maxlength="220" placeholder="${isStory?'Make it oddly specific. The details sell it…':'Write a convincing fake answer…'}" required></textarea>${isStory ? `<div style="margin-top:14px"><label>IS YOUR STORY TRUE OR A BLUFF?</label><div class="truth-picker"><button type="button" class="truth-choice true-choice ${truthChoice===true?'selected':''}" data-action="truth" data-truth="true">✓ It's TRUE</button><button type="button" class="truth-choice fake-choice ${truthChoice===false?'selected':''}" data-action="truth" data-truth="false">✦ It's a BLUFF</button></div></div>` : ''}<div class="form-bottom"><span class="character-count"><span id="char-count">0</span> / 220 characters</span><button class="button button-primary" type="submit">Lock it in <span>→</span></button></div></form><p class="small-note" style="margin-top:14px">${isStory?'The story truth stays secret until the round reveal.':'Remember: when someone picks your fake answer, you earn +2 points — but every wrong voter loses a life.'}</p>`;
  }
  function renderVote(g, me) {
    if (me?.eliminated) return `<div class="waiting-card"><div class="waiting-icon">♡</div><h3>You're watching this vote.</h3><p>You are eliminated, so you can't vote again. See if the others catch the bluff.</p></div>`;
    if (g.type === 'story') {
      if (g.myTurnToTellStory) return `<div class="waiting-card"><div class="waiting-icon">✦</div><h3>Your story is on trial.</h3><p>Other players are deciding whether your story is true or a bluff. Every opponent you fool earns you +2 points.</p><div class="submitted-list"><div class="submitted-row"><span>Votes received</span><strong>${g.votedCount} / ${g.voterCount}</strong></div></div></div>`;
      if (g.myVote !== null && g.myVote !== undefined) return `<div class="waiting-card"><div class="waiting-icon">✓</div><h3>Vote recorded.</h3><p>You voted <strong>${g.myVote === 'true' ? 'TRUE' : 'BLUFF'}</strong>. Your call is locked. Results will appear when everyone has voted.</p><div class="submitted-list"><div class="submitted-row"><span>Votes in</span><strong>${g.votedCount} / ${g.voterCount}</strong></div></div></div>`;
      return `<div class="instruction-box"><strong>MAKE YOUR CALL:</strong> Is ${esc(g.storytellerName)} telling the truth, or selling a very convincing lie? A wrong vote costs one life.</div><div class="vote-choice-row"><button class="vote-truth" data-action="vote-story" data-choice="true">✓ TRUE<small>I believe this happened</small></button><button class="vote-bluff" data-action="vote-story" data-choice="fake">✦ BLUFF<small>That's made up</small></button></div><p class="small-note" style="margin-top:15px">This is your only vote for the round. Trust your gut.</p>`;
    }
    if (g.myVote !== null && g.myVote !== undefined) {
      const selected = g.options?.find(o => o.id === g.myVote);
      return `<div class="waiting-card"><div class="waiting-icon">✓</div><h3>Vote locked.</h3><p>Your pick is recorded. You're betting on which answer is real. Results reveal when the crew is done voting.</p>${selected?`<div class="submitted-list"><div class="submitted-row"><span>Your pick</span><span>${esc(selected.text).slice(0,90)}</span></div></div>`:''}<div class="submitted-list"><div class="submitted-row"><span>Votes in</span><strong>${g.votedCount} / ${g.voterCount}</strong></div></div></div>`;
    }
    return `<div class="instruction-box"><strong>WHICH ANSWER IS TRUE?</strong> Choose the real answer. If you select a fake, lose one life — and the player who wrote it earns +2.</div><div class="vote-grid">${(g.options || []).map((option, i) => `<button class="vote-option" data-action="vote-card" data-choice="${esc(option.id)}"><span class="option-index">${String.fromCharCode(65+i)}</span><span class="option-text">${esc(option.text)}</span></button>`).join('')}</div><p class="small-note" style="margin-top:15px">Your own answer is hidden from your choices. No changing your mind after the vote.</p>`;
  }
  function renderResults(g) {
    const r = g.results || { cards:[], votes:[], pointChanges:{}, lifeChanges:{} };
    const isStory = g.type === 'story';
    const correctVoters = (r.votes || []).filter(v=>v.correct).length;
    const missedVoters = (r.votes || []).length - correctVoters;
    let cards = '';
    if (isStory) {
      const story = (r.submissions || [])[0];
      const actualStory = (r.submissions || []).find(s => s.playerId === g.storytellerId);
      const trueStory = r.storytellerTruth;
      cards = actualStory ? `<div class="result-cards"><div class="result-answer ${trueStory?'correct':'fake'}"><div class="answer-check">${trueStory?'✓':'✦'}</div><div class="result-answer-text">${esc(actualStory.text)}<span class="answer-by">Story by ${esc(actualStory.playerName)}</span></div><span class="truth-pill ${trueStory?'':'fake-pill'}">${trueStory?'TRUE':'BLUFF'}</span></div></div>` : '';
    } else {
      cards = `<div class="result-cards">${(r.cards || []).map((card,i)=>`<div class="result-answer ${card.isTruth?'correct':'fake'}"><div class="answer-check">${card.isTruth?'✓':String.fromCharCode(65+i)}</div><div class="result-answer-text">${esc(card.text)}<span class="answer-by">${card.isTruth?'The real answer':`Bluff by ${esc(card.authorName)}`}</span></div><span class="truth-pill ${card.isTruth?'':'fake-pill'}">${card.isTruth?'TRUE':'FAKE'}</span></div>`).join('')}</div>`;
    }
    const changed = Object.entries(r.pointChanges || {}).filter(([,n])=>n!==0);
    const summary = isStory ? `${correctVoters} correct call${correctVoters===1?'':'s'} · ${missedVoters} fooled` : `${correctVoters} correct call${correctVoters===1?'':'s'} · ${missedVoters} fooled`;
    const voteLog = (r.votes || []).length ? `<div class="side-heading" style="margin-top:18px"><h3>WHO CALLED IT?</h3><span>${(r.votes||[]).length} VOTES</span></div><div class="vote-log">${r.votes.map(v=>`<div class="vote-log-row"><span>${esc(v.playerName)} ${v.playerId===state.viewerId?'(you)':''}</span><span class="vote-status ${v.correct?'good':'bad'}">${v.correct?'✓ CORRECT':'✕ FOOLED'} ${v.correct?'+2':'−1 ♥'}</span></div>`).join('')}</div>` : '<p class="small-note">No votes were cast before the round ended.</p>';
    const explanation = g.hint ? `<p class="small-note" style="margin-top:15px"><strong>WHY:</strong> ${esc(g.hint)}</p>` : '';
    const isEnded = state.status === 'ended';
    const action = isEnded
      ? (state.isHost ? `<button class="button button-primary" data-action="rematch">Run it back ↻</button>` : `<button class="button button-secondary" disabled>Waiting for host rematch…</button>`)
      : (state.isHost ? `<button class="button button-primary" data-action="next-round">${g.isLastRound?'Finish game':'Next round →'}</button>` : `<button class="button button-secondary" disabled>Waiting for host…</button>`);
    const closeText = isEnded ? 'Final scores are locked.' : 'Points are added. Incorrect votes cost a life.';
    return `<div class="result-banner"><div class="result-icon">${isEnded?'♛':'✦'}</div><div><h3>${isEnded?'Game complete!':'The truth comes out.'}</h3><p>${esc(summary)}. ${esc(closeText)}</p></div></div>${cards}${explanation}${voteLog}<div class="result-actions">${action}</div><p class="small-note" style="margin-top:12px">${isEnded?'Want another shot at the crown? The host can start a rematch.':'Scores and lives are now updated on every device.'}</p>`;
  }

  // One delegated event handler keeps controls working after screen re-renders.
  document.addEventListener('click', async (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      if (action === 'ready') socket.emit('player:ready', { ready: true });
      if (action === 'unready') socket.emit('player:ready', { ready: false });
      if (action === 'start') socket.emit('game:start');
      if (action === 'truth') {
        truthChoice = actionEl.dataset.truth === 'true';
        $$('.truth-choice').forEach(btn => btn.classList.toggle('selected', btn === actionEl));
      }
      if (action === 'vote-story') socket.emit('round:vote', { choice: actionEl.dataset.choice });
      if (action === 'vote-card') socket.emit('round:vote', { choice: actionEl.dataset.choice });
      if (action === 'next-round') socket.emit('game:next-round');
      if (action === 'rematch') socket.emit('game:rematch');
      if (action === 'copy-code') await copyText(state?.code || '', 'Room code copied.');
      if (action === 'copy-link') await copyText($('#share-link')?.value || location.href, 'Invite link copied.');
    }
    if (event.target.closest('#create-room')) {
      const name = cleanNameFromInput();
      if (!name) return toast('Enter your player name first.', 'error');
      socket.emit('room:create', { name });
    }
    if (event.target.closest('#join-room')) {
      const name = cleanNameFromInput(); const code = String($('#room-code').value || '').trim().toUpperCase();
      if (!name) return toast('Enter your player name first.', 'error');
      if (code.length !== 5) return toast('Enter the 5-character room code.', 'error');
      socket.emit('room:join', { code, name });
    }
    if (event.target.closest('#leave-top')) {
      socket.emit('room:leave'); goHome(); toast('You left the room.');
    }
    if (event.target.closest('#brand-home') && state) {
      event.preventDefault(); toast('Use the leave button to exit your current room.', 'error');
    }
  });
  document.addEventListener('submit', event => {
    if (event.target.id !== 'submit-form') return;
    event.preventDefault();
    const text = $('#answer-text')?.value.trim() || '';
    if (text.length < 3) return toast('Write at least 3 characters.', 'error');
    const isStory = state?.game?.type === 'story';
    if (isStory && truthChoice === null) return toast('Choose whether your story is true or a bluff.', 'error');
    socket.emit('round:submit', isStory ? { text, truth: truthChoice } : { text });
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'answer-text') {
      const counter = $('#char-count'); if (counter) counter.textContent = event.target.value.length;
    }
    if (event.target.id === 'room-code') event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);
  });
  async function copyText(text, successMessage) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast(successMessage, 'success'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      const copied = document.execCommand('copy'); ta.remove(); toast(copied ? successMessage : 'Could not copy automatically — select and copy the text.', copied ? 'success' : 'error');
    }
  }

  // Allow an invited friend to open a room-code link, then enter their name and join.
  const queryCode = new URLSearchParams(location.search).get('room');
  if (queryCode && !session) $('#room-code').value = queryCode.toUpperCase().slice(0,5);
  setNameFromSession();
  if (session?.code) toast('Reconnecting to your saved room…');
})();
