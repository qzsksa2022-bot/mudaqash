'use strict';

const socket = io();

const el = (id) => document.getElementById(id);
const RED_SUITS = ['♥', '♦'];

let myId = null;
let myCode = null;
let lastState = null;
let lastShowdownShownRound = -1;
let lastGameOverShown = false;

// ===================== شاشات =====================

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  el('screen-' + name).classList.add('active');
}

function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ===================== تبويبات الشاشة الرئيسية =====================

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    el('tab-' + btn.dataset.tab).classList.add('active');
  });
});

el('btn-create').addEventListener('click', () => {
  const name = el('create-name').value.trim();
  if (!name) return (el('home-error').textContent = 'اكتب اسمك أولاً');
  socket.emit(
    'createRoom',
    {
      name,
      maxPlayers: Number(el('create-max').value) || 8,
      startingBalance: Number(el('create-balance').value) || 10000,
      minRaise: Number(el('create-minraise').value) || 100,
    },
    (res) => {
      if (!res.ok) return (el('home-error').textContent = res.error);
      onJoined(res.code, res.playerId);
    }
  );
});

el('btn-join').addEventListener('click', () => {
  const name = el('join-name').value.trim();
  const code = el('join-code').value.trim().toUpperCase();
  if (!name) return (el('home-error').textContent = 'اكتب اسمك أولاً');
  if (!code) return (el('home-error').textContent = 'اكتب كود الغرفة');
  socket.emit('joinRoom', { name, code }, (res) => {
    if (!res.ok) return (el('home-error').textContent = res.error);
    onJoined(res.code, res.playerId);
  });
});

function onJoined(code, playerId) {
  myId = playerId;
  myCode = code;
  localStorage.setItem('mudaqash_code', code);
  localStorage.setItem('mudaqash_playerId', playerId);
  el('home-error').textContent = '';
}

// محاولة الرجوع التلقائي لنفس الغرفة بعد تحديث الصفحة
window.addEventListener('load', () => {
  const code = localStorage.getItem('mudaqash_code');
  const playerId = localStorage.getItem('mudaqash_playerId');
  if (code && playerId) {
    socket.emit('rejoinRoom', { code, playerId }, (res) => {
      if (res.ok) {
        myId = playerId;
        myCode = code;
      }
    });
  }
});

// ===================== اللوبي =====================

el('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard?.writeText(myCode || '').then(() => toast('تم نسخ الكود'));
});

el('btn-start-game').addEventListener('click', () => {
  socket.emit('startGame', {}, (res) => {
    if (!res.ok) el('lobby-error').textContent = res.error;
  });
});

// ===================== لوحات جانبية =====================

el('btn-log-toggle').addEventListener('click', () => el('log-panel').classList.add('open'));
el('btn-log-close').addEventListener('click', () => el('log-panel').classList.remove('open'));
el('btn-rules-toggle').addEventListener('click', () => el('rules-panel').classList.add('open'));
el('btn-rules-close').addEventListener('click', () => el('rules-panel').classList.remove('open'));

// ===================== أدوات الأوراق =====================

function cardEl(card, small) {
  const red = RED_SUITS.includes(card.suit);
  const div = document.createElement('div');
  div.className = (small ? 'mini-card revealed' : 'card') + (red ? ' red' : '');
  if (small) {
    div.textContent = card.rank + card.suit;
  } else {
    div.innerHTML = `<div>${card.rank}</div><div class="suit">${card.suit}</div>`;
  }
  return div;
}

// ===================== استقبال حالة اللعبة =====================

socket.on('state', (state) => {
  lastState = state;
  render(state);
});

socket.on('errorMsg', (msg) => toast(msg));

function render(state) {
  if (state.state === 'lobby') {
    showScreen('lobby');
    el('lobby-code').textContent = state.code;
    const list = el('lobby-players');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${p.name}${p.connected ? '' : ' (غير متصل)'}</span>` +
        (p.id === state.hostId ? '<span class="host-badge">👑 صاحب الغرفة</span>' : '');
      list.appendChild(li);
    });
    el('btn-start-game').style.display = state.hostId === myId ? 'block' : 'none';
    return;
  }

  showScreen('table');
  el('round-num').textContent = state.roundNumber;
  el('pot-amount').textContent = state.pot;

  renderPlayers(state);
  renderMyHand(state);
  renderBanner(state);
  renderActionBar(state);
  renderLog(state);

  if (state.state === 'roundEnd' && state.lastShowdown && state.roundNumber !== lastShowdownShownRound) {
    lastShowdownShownRound = state.roundNumber;
    showShowdownModal(state);
  }

  if (state.state === 'gameOver' && !lastGameOverShown) {
    lastGameOverShown = true;
    showGameOverModal(state);
  }
  if (state.state !== 'gameOver') lastGameOverShown = false;
}

function renderPlayers(state) {
  const wrap = el('table-players');
  wrap.innerHTML = '';
  state.players.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'player-card';
    if (p.id === state.turnPlayerId) card.classList.add('turn');
    if (p.folded) card.classList.add('folded');
    if (p.eliminated) card.classList.add('eliminated');
    if (p.id === myId) card.classList.add('me');

    const cardsHtml = document.createElement('div');
    cardsHtml.className = 'mini-cards';
    if (p.revealedHand) {
      p.revealedHand.forEach((c) => cardsHtml.appendChild(cardEl(c, true)));
    } else if (!p.folded && !p.eliminated) {
      for (let i = 0; i < p.cardCount; i++) {
        const mc = document.createElement('div');
        mc.className = 'mini-card';
        cardsHtml.appendChild(mc);
      }
    }

    let statusText = '';
    if (p.eliminated) statusText = 'خرج من اللعبة';
    else if (p.folded) statusText = 'منسحب';
    else if (p.settledOut) statusText = 'خرج بالتسوية';

    card.innerHTML = `
      <div class="player-name-row">
        <span>${p.isBoss ? '<span class="boss-crown">👑</span>' : ''}${p.name}</span>
      </div>
      <div class="player-balance">💰 ${p.balance}</div>
      ${p.committed ? `<div class="player-committed">راهن: ${p.committed}</div>` : ''}
      ${statusText ? `<div class="player-status">${statusText}</div>` : ''}
    `;
    card.appendChild(cardsHtml);
    wrap.appendChild(card);
  });
}

function renderMyHand(state) {
  const wrap = el('my-hand');
  wrap.innerHTML = '';
  if (!state.me || !state.me.hand || state.me.hand.length === 0) return;
  state.me.hand.forEach((c) => wrap.appendChild(cardEl(c, false)));
}

function renderBanner(state) {
  const banner = el('banner');
  if (state.state === 'betting') {
    if (state.turnPlayerId === myId) banner.textContent = '🎯 دورك! راهن أو جاري أو انسحب';
    else {
      const p = state.players.find((pl) => pl.id === state.turnPlayerId);
      banner.textContent = p ? `بانتظار ${p.name}...` : '';
    }
  } else if (state.state === 'negotiation') {
    const boss = state.players.find((pl) => pl.isBoss);
    const neg = state.negotiation;
    if (neg && neg.pendingOffer) {
      const target = state.players.find((pl) => pl.id === neg.pendingOffer.targetId);
      banner.textContent = `${boss?.name || ''} عرض ${neg.pendingOffer.amount} على ${target?.name || ''}`;
    } else {
      banner.textContent = `👑 ${boss?.name || ''} يفاوض... (${neg ? neg.attemptsLeft : 0} محاولات متبقية)`;
    }
  } else if (state.state === 'roundEnd') {
    banner.textContent = 'انتهت الجولة';
  } else if (state.state === 'gameOver') {
    banner.textContent = 'انتهت اللعبة 🏆';
  } else {
    banner.textContent = '';
  }
}

function renderActionBar(state) {
  const bar = el('action-bar');
  bar.innerHTML = '';

  if (state.state === 'betting' && state.turnPlayerId === myId && state.me && !state.me.folded) {
    const foldBtn = document.createElement('button');
    foldBtn.className = 'btn-fold';
    foldBtn.textContent = 'انسحاب';
    foldBtn.onclick = () => socket.emit('fold', {}, ackHandler);
    bar.appendChild(foldBtn);

    if (state.currentBet > 0 && state.me.committed < state.currentBet) {
      const callBtn = document.createElement('button');
      callBtn.className = 'btn-call';
      const need = Math.min(state.currentBet - state.me.committed, state.me.balance);
      callBtn.textContent = `مجاراة (${state.currentBet})`;
      callBtn.onclick = () => socket.emit('call', {}, ackHandler);
      bar.appendChild(callBtn);
    }

    const input = document.createElement('input');
    input.type = 'number';
    const minTarget = state.currentBet + state.settings.minRaise;
    input.value = minTarget;
    input.min = minTarget;
    bar.appendChild(input);

    const raiseBtn = document.createElement('button');
    raiseBtn.className = 'btn-raise';
    raiseBtn.textContent = 'رفع';
    raiseBtn.onclick = () => {
      const amount = Number(input.value);
      socket.emit('raise', { amount }, ackHandler);
    };
    bar.appendChild(raiseBtn);
  } else if (state.state === 'negotiation') {
    const neg = state.negotiation;
    const iAmBoss = neg && neg.bossId === myId;
    const iAmTarget = neg && neg.pendingOffer && neg.pendingOffer.targetId === myId;

    if (iAmTarget) {
      const info = document.createElement('span');
      info.className = 'waiting-text';
      info.textContent = `عرضوا عليك ${neg.pendingOffer.amount} مقابل الانسحاب`;
      bar.appendChild(info);

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'btn-accept';
      acceptBtn.textContent = 'موافق ✅';
      acceptBtn.onclick = () => socket.emit('respondOffer', { accept: true }, ackHandler);
      bar.appendChild(acceptBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn-reject';
      rejectBtn.textContent = 'رفض ❌';
      rejectBtn.onclick = () => socket.emit('respondOffer', { accept: false }, ackHandler);
      bar.appendChild(rejectBtn);
    } else if (iAmBoss && !neg.pendingOffer) {
      const others = state.players.filter(
        (p) => p.id !== myId && !p.folded && !p.settledOut && !p.eliminated
      );
      if (neg.attemptsLeft > 0 && others.length > 0) {
        const select = document.createElement('select');
        select.className = 'select-target';
        others.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name;
          select.appendChild(opt);
        });
        bar.appendChild(select);

        const input = document.createElement('input');
        input.type = 'number';
        input.value = Math.max(100, Math.floor(state.pot / 4));
        bar.appendChild(input);

        const offerBtn = document.createElement('button');
        offerBtn.className = 'btn-raise';
        offerBtn.textContent = `فاوض (${neg.attemptsLeft} متبقية)`;
        offerBtn.onclick = () => {
          socket.emit(
            'offerNegotiation',
            { targetId: select.value, amount: Number(input.value) },
            ackHandler
          );
        };
        bar.appendChild(offerBtn);
      }

      const showdownBtn = document.createElement('button');
      showdownBtn.className = 'btn-fold';
      showdownBtn.textContent = '🃏 أعلن المداقش';
      showdownBtn.onclick = () => socket.emit('declareShowdown', {}, ackHandler);
      bar.appendChild(showdownBtn);
    } else {
      const info = document.createElement('span');
      info.className = 'waiting-text';
      info.textContent = 'الشيخ يفاوض الآن...';
      bar.appendChild(info);
    }
  } else if (state.state === 'roundEnd') {
    if (state.hostId === myId) {
      const nextBtn = document.createElement('button');
      nextBtn.className = 'btn-raise';
      nextBtn.textContent = 'ابدأ الجولة القادمة ▶';
      nextBtn.onclick = () => socket.emit('nextRound', {}, ackHandler);
      bar.appendChild(nextBtn);
    } else {
      const info = document.createElement('span');
      info.className = 'waiting-text';
      info.textContent = 'بانتظار صاحب الغرفة لبدء الجولة القادمة...';
      bar.appendChild(info);
    }
  } else {
    const info = document.createElement('span');
    info.className = 'waiting-text';
    info.textContent = state.state === 'gameOver' ? 'انتهت اللعبة' : 'بانتظار...';
    bar.appendChild(info);
  }
}

function renderLog(state) {
  const list = el('log-list');
  list.innerHTML = '';
  state.log.forEach((l) => {
    const div = document.createElement('div');
    div.textContent = l.msg;
    list.appendChild(div);
  });
  list.scrollTop = list.scrollHeight;
}

function ackHandler(res) {
  if (res && !res.ok) toast(res.error);
}

// ===================== مودال المداقش =====================

function showShowdownModal(state) {
  const wrap = el('showdown-results');
  wrap.innerHTML = '';
  const sd = state.lastShowdown;
  sd.results.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'showdown-row' + (sd.winners.includes(r.playerId) ? ' winner' : '');
    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'showdown-cards';
    r.hand.forEach((c) => cardsWrap.appendChild(cardEl(c, true)));
    const left = document.createElement('div');
    left.innerHTML = `<b>${r.name}</b><br/><span>${r.category}</span>`;
    row.appendChild(left);
    row.appendChild(cardsWrap);
    wrap.appendChild(row);
  });
  el('showdown-modal').classList.add('open');
}
el('btn-showdown-close').addEventListener('click', () => el('showdown-modal').classList.remove('open'));

// ===================== مودال نهاية اللعبة =====================

function showGameOverModal(state) {
  const winner = state.players.find((p) => p.id === state.winnerId);
  el('gameover-text').textContent = winner
    ? `🏆 الفائز الكبير هو: ${winner.name} برصيد ${winner.balance}!`
    : 'انتهت اللعبة.';
  el('gameover-modal').classList.add('open');
}
el('btn-gameover-close').addEventListener('click', () => {
  el('gameover-modal').classList.remove('open');
  localStorage.removeItem('mudaqash_code');
  localStorage.removeItem('mudaqash_playerId');
  location.reload();
});
