'use strict';

// ===================== أدوات عامة =====================

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2])); // 2..14

function buildDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ rank: r, suit: s });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ===================== تقييم الأوراق (مشروع مداقش) =====================
// الترتيب من الأقوى للأضعف:
// 6: رباعية (Four of a kind)
// 5: تتابع (Straight - 4 رتب متتالية)
// 4: ثلاثية (Three of a kind)
// 3: زوجين (Two pair)
// 2: زوج (One pair)
// 1: ورقة عالية (High card)

function evaluateHand(cards) {
  const values = cards.map((c) => RANK_VALUE[c.rank]).sort((a, b) => b - a);
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([v, c]) => ({ value: Number(v), count: c }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  const isFourKind = groups[0].count === 4;
  const isThreeKind = groups[0].count === 3;
  const isTwoPair = groups[0].count === 2 && groups[1] && groups[1].count === 2;
  const isOnePair = groups[0].count === 2 && !isTwoPair;

  const uniqueSorted = [...new Set(values)].sort((a, b) => b - a);
  const isStraight =
    uniqueSorted.length === 4 && uniqueSorted[0] - uniqueSorted[3] === 3;

  let category, tiebreak;
  if (isFourKind) {
    category = 6;
    tiebreak = [groups[0].value];
  } else if (isStraight) {
    category = 5;
    tiebreak = [uniqueSorted[0]];
  } else if (isThreeKind) {
    category = 4;
    tiebreak = [groups[0].value, ...groups.slice(1).map((g) => g.value)];
  } else if (isTwoPair) {
    category = 3;
    tiebreak = [groups[0].value, groups[1].value];
  } else if (isOnePair) {
    category = 2;
    tiebreak = [groups[0].value, ...groups.slice(1).map((g) => g.value)];
  } else {
    category = 1;
    tiebreak = uniqueSorted;
  }
  return { category, tiebreak, cards };
}

const CATEGORY_NAMES = {
  6: 'رباعية',
  5: 'تتابع',
  4: 'ثلاثية',
  3: 'زوجين',
  2: 'زوج',
  1: 'ورقة عالية',
};

function compareHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < a.tiebreak.length; i++) {
    if (a.tiebreak[i] !== b.tiebreak[i]) return a.tiebreak[i] - b.tiebreak[i];
  }
  return 0;
}

// ===================== غرفة اللعب =====================

class Room {
  constructor(code, settings) {
    this.code = code;
    this.settings = {
      maxPlayers: settings.maxPlayers || 8,
      startingBalance: settings.startingBalance || 10000,
      minRaise: settings.minRaise || 100,
    };
    this.players = []; // { id, name, socketId, seat, balance, hand, folded, connected, eliminated, committed }
    this.hostId = null;
    this.state = 'lobby'; // lobby | betting | negotiation | showdown | roundEnd | gameOver
    this.dealerSeat = -1;
    this.deck = [];
    this.pot = 0;
    this.currentBet = 0;
    this.turnPlayerId = null;
    this.toAct = []; // ids still needing to act this betting round
    this.lastRaiserId = null;
    this.negotiation = null;
    this.log = [];
    this.winnerId = null;
    this.roundNumber = 0;
    this.lastActivity = Date.now();
  }

  addLog(msg) {
    this.log.push({ msg, ts: Date.now() });
    if (this.log.length > 200) this.log.shift();
    this.lastActivity = Date.now();
  }

  get activePlayers() {
    return this.players.filter((p) => !p.folded && !p.settledOut && !p.eliminated);
  }

  get inGamePlayers() {
    return this.players.filter((p) => !p.eliminated);
  }

  findPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  addPlayer(id, socketId, name) {
    if (this.players.length >= this.settings.maxPlayers) {
      throw new Error('الغرفة مكتملة');
    }
    if (this.state !== 'lobby') {
      throw new Error('اللعبة بدأت بالفعل، لا يمكن الانضمام الآن');
    }
    const seat = this.players.length;
    const player = {
      id,
      socketId,
      name,
      seat,
      balance: this.settings.startingBalance,
      hand: [],
      folded: false,
      settledOut: false,
      eliminated: false,
      connected: true,
      committed: 0,
      isBoss: false,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = id;
    this.addLog(`${name} انضم إلى الطاولة`);
    return player;
  }

  removePlayer(id) {
    // لا نحذف اللاعب فورًا عند انقطاع الاتصال (مثلاً لما يبدّل التطبيقات
    // بجواله لحظة عشان يرسل كود الغرفة لصديقه) — بس نعلّمه كغير متصل.
    // هذا يمنع حذف الغرفة بالغلط لو كل اللاعبين انقطعوا لحظيًا.
    const p = this.findPlayer(id);
    if (!p) return;
    p.connected = false;
    this.lastActivity = Date.now();
  }

  leaveRoomPermanently(id) {
    const p = this.findPlayer(id);
    if (!p) return;
    if (this.state === 'lobby') {
      this.players = this.players.filter((pl) => pl.id !== id);
      if (this.hostId === id) {
        this.hostId = this.players.length ? this.players[0].id : null;
      }
    } else {
      p.connected = false;
    }
  }

  hasAnyConnectedPlayer() {
    return this.players.some((p) => p.connected);
  }

  canStart() {
    return this.state === 'lobby' && this.players.length >= 3;
  }

  startGame() {
    if (!this.canStart()) throw new Error('لا يمكن بدء اللعبة الآن (بحاجة 3 لاعبين على الأقل)');
    this.roundNumber = 0;
    this.dealerSeat = -1;
    this.startRound();
  }

  nextDealerSeat() {
    const eligible = this.inGamePlayers;
    if (eligible.length === 0) return -1;
    let seat = this.dealerSeat;
    for (let i = 0; i < this.players.length; i++) {
      seat = (seat + 1) % this.players.length;
      const p = this.players.find((pl) => pl.seat === seat);
      if (p && !p.eliminated) return seat;
    }
    return this.dealerSeat;
  }

  startRound() {
    this.roundNumber++;
    this.dealerSeat = this.nextDealerSeat();
    this.deck = shuffle(buildDeck());
    this.pot = 0;
    this.currentBet = 0;
    this.lastRaiserId = null;
    this.winnerId = null;
    this.negotiation = null;

    for (const p of this.players) {
      p.hand = [];
      p.folded = p.eliminated; // اللاعبون الخارجون من قبل يبقون خارج الجولة
      p.settledOut = false;
      p.committed = 0;
      p.isBoss = false;
    }

    for (const p of this.inGamePlayers) {
      p.hand = [this.deck.pop(), this.deck.pop(), this.deck.pop(), this.deck.pop()];
    }

    this.addLog(`— بدأت الجولة #${this.roundNumber} —`);

    const order = this.turnOrderFromDealer();
    this.state = 'betting';
    this.toAct = order.map((p) => p.id);
    this.turnPlayerId = order[0] ? order[0].id : null;
    if (this.turnPlayerId) {
      const first = this.findPlayer(this.turnPlayerId);
      this.addLog(`دور ${first.name} للمراهنة`);
    }
  }

  turnOrderFromDealer() {
    const n = this.players.length;
    const order = [];
    for (let i = 1; i <= n; i++) {
      const seat = (this.dealerSeat + i) % n;
      const p = this.players.find((pl) => pl.seat === seat);
      if (p && !p.eliminated) order.push(p);
    }
    return order;
  }

  // ---------------- مرحلة المراهنة ----------------

  assertTurn(playerId) {
    if (this.state !== 'betting') throw new Error('ليست مرحلة المراهنة الآن');
    if (this.turnPlayerId !== playerId) throw new Error('ليس دورك');
  }

  advanceTurn() {
    this.toAct.shift();
    if (this.toAct.length === 0) {
      this.endBettingRound();
      return;
    }
    this.turnPlayerId = this.toAct[0];
  }

  fold(playerId) {
    this.assertTurn(playerId);
    const p = this.findPlayer(playerId);
    p.folded = true;
    this.addLog(`${p.name} انسحب`);
    const active = this.activePlayers;
    if (active.length === 1) {
      this.finishRoundUncontested(active[0]);
      return;
    }
    this.advanceTurn();
  }

  raise(playerId, amount) {
    this.assertTurn(playerId);
    const p = this.findPlayer(playerId);
    amount = Math.floor(amount);
    const maxPossible = p.balance + p.committed; // أقصى ما يقدر يوصله (all-in)
    const minTarget = this.currentBet + this.settings.minRaise;
    if (amount > maxPossible) amount = maxPossible; // سقف الرصيد
    if (amount <= this.currentBet) {
      throw new Error(`يجب أن تكون المراهنة أعلى من ${this.currentBet}`);
    }
    if (amount < minTarget && amount < maxPossible) {
      throw new Error(`أقل رفع مسموح هو ${minTarget}`);
    }
    const delta = amount - p.committed;
    p.balance -= delta;
    p.committed = amount;
    this.pot += delta;
    this.currentBet = amount;
    this.lastRaiserId = playerId;
    this.addLog(`${p.name} راهن بـ ${amount}${p.balance === 0 ? ' (كل الرصيد!)' : ''}`);

    // إعادة تعيين دور من يجب أن يتصرف: كل النشطين ما عدا الرافع
    const order = this.turnOrderFromDealer().map((pl) => pl.id);
    const startIdx = order.indexOf(playerId);
    const rotated = [...order.slice(startIdx + 1), ...order.slice(0, startIdx)];
    this.toAct = rotated.filter((id) => {
      const pl = this.findPlayer(id);
      return pl && !pl.folded && !pl.eliminated;
    });
    if (this.toAct.length === 0) {
      this.endBettingRound();
    } else {
      this.turnPlayerId = this.toAct[0];
    }
  }

  call(playerId) {
    this.assertTurn(playerId);
    const p = this.findPlayer(playerId);
    if (this.currentBet === 0) {
      throw new Error('لا يوجد رهان لمجاراته، راهن أو انسحب');
    }
    const target = Math.min(this.currentBet, p.balance + p.committed);
    const delta = target - p.committed;
    p.balance -= delta;
    p.committed = target;
    this.pot += delta;
    this.addLog(`${p.name} جارى الرهان (${target})${p.balance === 0 ? ' - كل الرصيد!' : ''}`);
    this.advanceTurn();
  }

  endBettingRound() {
    const active = this.activePlayers;
    if (active.length === 1) {
      this.finishRoundUncontested(active[0]);
      return;
    }
    // يصبح آخر من رفع (أو أول لاعب لو محد رفع) هو "الشيخ"
    const bossId = this.lastRaiserId || active[0].id;
    const boss = this.findPlayer(bossId);
    boss.isBoss = true;
    this.state = 'negotiation';
    this.negotiation = {
      bossId,
      attemptsLeft: 3,
      pendingOffer: null,
    };
    this.turnPlayerId = bossId;
    this.addLog(`انتهت المراهنة. ${boss.name} أصبح "الشيخ" 👑 ويملك 3 محاولات للمفاوضة أو يعلن المداقش مباشرة`);
  }

  finishRoundUncontested(winner) {
    winner.balance += this.pot;
    this.addLog(`${winner.name} فاز بالجولة بدون كشف الأوراق وحصل على ${this.pot}`);
    this.pot = 0;
    this.state = 'roundEnd';
    this.checkElimination();
  }

  // ---------------- مرحلة المفاوضة ----------------

  offerNegotiation(bossId, targetId, amount) {
    if (this.state !== 'negotiation') throw new Error('ليست مرحلة المفاوضة');
    const neg = this.negotiation;
    if (neg.bossId !== bossId) throw new Error('فقط الشيخ يقدر يفاوض');
    if (neg.pendingOffer) throw new Error('في عرض قائم بانتظار الرد');
    if (neg.attemptsLeft <= 0) throw new Error('انتهت محاولات المفاوضة');
    const boss = this.findPlayer(bossId);
    const target = this.findPlayer(targetId);
    if (!target || target.folded || target.settledOut || target.eliminated || targetId === bossId) {
      throw new Error('لاعب غير صالح للمفاوضة');
    }
    amount = Math.floor(amount);
    if (amount <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
    if (amount > boss.balance) throw new Error('لا يوجد رصيد كافٍ لهذا العرض');

    neg.pendingOffer = { targetId, amount };
    neg.attemptsLeft -= 1;
    this.addLog(`${boss.name} عرض على ${target.name} مبلغ ${amount} مقابل الانسحاب بدون كشف أوراقه`);
  }

  respondOffer(targetId, accept) {
    if (this.state !== 'negotiation') throw new Error('ليست مرحلة المفاوضة');
    const neg = this.negotiation;
    if (!neg.pendingOffer || neg.pendingOffer.targetId !== targetId) {
      throw new Error('لا يوجد عرض موجه لك حاليًا');
    }
    const boss = this.findPlayer(neg.bossId);
    const target = this.findPlayer(targetId);
    const { amount } = neg.pendingOffer;

    if (accept) {
      boss.balance -= amount;
      target.balance += amount;
      target.settledOut = true;
      this.addLog(`${target.name} وافق وأخذ ${amount} من ${boss.name} دون كشف أوراقه`);
      neg.pendingOffer = null;

      const active = this.activePlayers;
      if (active.length === 1) {
        this.finishRoundUncontested(active[0]);
        return;
      }
      this.turnPlayerId = boss.id;
      if (neg.attemptsLeft <= 0) {
        this.doShowdown();
      }
    } else {
      this.addLog(`${target.name} رفض عرض ${boss.name}`);
      neg.pendingOffer = null;
      this.turnPlayerId = boss.id;
      if (neg.attemptsLeft <= 0) {
        this.doShowdown();
      }
    }
  }

  declareShowdown(bossId) {
    if (this.state !== 'negotiation') throw new Error('ليست مرحلة المفاوضة');
    if (this.negotiation.bossId !== bossId) throw new Error('فقط الشيخ يقدر يعلن المداقش');
    if (this.negotiation.pendingOffer) throw new Error('في عرض قائم بانتظار الرد أولاً');
    this.doShowdown();
  }

  doShowdown() {
    const active = this.activePlayers;
    const results = active.map((p) => ({ player: p, hand: evaluateHand(p.hand) }));
    results.sort((a, b) => compareHands(b.hand, a.hand));
    const best = results[0].hand;
    const winners = results.filter((r) => compareHands(r.hand, best) === 0);
    const share = Math.floor(this.pot / winners.length);
    let remainder = this.pot - share * winners.length;

    for (const w of winners) {
      w.player.balance += share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    }

    this.addLog(
      `🃏 المداقش! ${results
        .map((r) => `${r.player.name}: ${CATEGORY_NAMES[r.hand.category]}`)
        .join(' | ')}`
    );
    this.addLog(
      winners.length > 1
        ? `تعادل بين: ${winners.map((w) => w.player.name).join(' و ')} — يتقاسمون ${this.pot}`
        : `${winners[0].player.name} فاز بالمداقش وحصل على ${this.pot}`
    );

    this.lastShowdown = {
      results: results.map((r) => ({
        playerId: r.player.id,
        name: r.player.name,
        hand: r.player.hand,
        category: CATEGORY_NAMES[r.hand.category],
      })),
      winners: winners.map((w) => w.player.id),
    };

    this.pot = 0;
    this.state = 'roundEnd';
    this.checkElimination();
  }

  checkElimination() {
    for (const p of this.players) {
      if (p.balance <= 0 && !p.eliminated) {
        p.eliminated = true;
        p.balance = 0;
        this.addLog(`💀 ${p.name} خرج من اللعبة (انتهى رصيده)`);
      }
    }
    const remaining = this.inGamePlayers;
    if (remaining.length <= 1) {
      this.state = 'gameOver';
      this.winnerId = remaining[0] ? remaining[0].id : null;
      if (this.winnerId) {
        this.addLog(`🏆 ${remaining[0].name} فاز باللعبة كاملة!`);
      }
    }
  }

  continueToNextRound() {
    if (this.state !== 'roundEnd') throw new Error('لا يمكن بدء جولة جديدة الآن');
    this.startRound();
  }

  // ---------------- تمثيل الحالة للعميل ----------------

  publicState(forPlayerId) {
    const me = this.findPlayer(forPlayerId);
    return {
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      settings: this.settings,
      pot: this.pot,
      currentBet: this.currentBet,
      turnPlayerId: this.turnPlayerId,
      dealerSeat: this.dealerSeat,
      roundNumber: this.roundNumber,
      winnerId: this.winnerId,
      negotiation: this.negotiation,
      lastShowdown: this.state === 'roundEnd' ? this.lastShowdown : null,
      log: this.log.slice(-40),
      me: me
        ? {
            id: me.id,
            hand: me.hand,
            balance: me.balance,
            committed: me.committed,
            folded: me.folded,
            settledOut: me.settledOut,
            eliminated: me.eliminated,
          }
        : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        balance: p.balance,
        committed: p.committed,
        folded: p.folded,
        settledOut: p.settledOut,
        eliminated: p.eliminated,
        connected: p.connected,
        isBoss: p.isBoss,
        cardCount: p.hand ? p.hand.length : 0,
        // نكشف الأوراق فقط في حالة المداقش (roundEnd مع lastShowdown) أو لصاحبها
        revealedHand:
          this.state === 'roundEnd' && this.lastShowdown
