'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');
const { Room } = require('./game');

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, Room>} */
const rooms = new Map();
// socket.id -> { code, playerId }
const socketMeta = new Map();

function broadcastRoom(room) {
  for (const p of room.players) {
    if (p.socketId) {
      io.to(p.socketId).emit('state', room.publicState(p.id));
    }
  }
}

function sendError(socket, message) {
  socket.emit('errorMsg', message);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, maxPlayers, startingBalance, minRaise }, cb) => {
    try {
      const code = nanoid();
      const room = new Room(code, { maxPlayers, startingBalance, minRaise });
      rooms.set(code, room);
      const player = room.addPlayer(socket.id, socket.id, (name || 'لاعب').slice(0, 20));
      socketMeta.set(socket.id, { code, playerId: player.id });
      socket.join(code);
      cb && cb({ ok: true, code, playerId: player.id });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    try {
      code = (code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) throw new Error('الغرفة غير موجودة');
      const player = room.addPlayer(socket.id, socket.id, (name || 'لاعب').slice(0, 20));
      socketMeta.set(socket.id, { code, playerId: player.id });
      socket.join(code);
      cb && cb({ ok: true, code, playerId: player.id });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('rejoinRoom', ({ code, playerId }, cb) => {
    try {
      code = (code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) throw new Error('الغرفة غير موجودة');
      const player = room.findPlayer(playerId);
      if (!player) throw new Error('لم يتم العثور على اللاعب في هذه الغرفة');
      player.socketId = socket.id;
      player.connected = true;
      room.lastActivity = Date.now();
      socketMeta.set(socket.id, { code, playerId });
      socket.join(code);
      cb && cb({ ok: true, code, playerId });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  function withRoom(handler) {
    return (payload, cb) => {
      try {
        const meta = socketMeta.get(socket.id);
        if (!meta) throw new Error('لست في أي غرفة');
        const room = rooms.get(meta.code);
        if (!room) throw new Error('الغرفة غير موجودة');
        handler(room, meta.playerId, payload || {});
        broadcastRoom(room);
        cb && cb({ ok: true });
      } catch (e) {
        if (cb) cb({ ok: false, error: e.message });
        else sendError(socket, e.message);
      }
    };
  }

  socket.on(
    'startGame',
    withRoom((room, playerId) => {
      if (room.hostId !== playerId) throw new Error('فقط صاحب الغرفة يقدر يبدأ اللعبة');
      room.startGame();
    })
  );

  socket.on(
    'fold',
    withRoom((room, playerId) => room.fold(playerId))
  );

  socket.on(
    'call',
    withRoom((room, playerId) => room.call(playerId))
  );

  socket.on(
    'raise',
    withRoom((room, playerId, { amount }) => room.raise(playerId, Number(amount)))
  );

  socket.on(
    'offerNegotiation',
    withRoom((room, playerId, { targetId, amount }) =>
      room.offerNegotiation(playerId, targetId, Number(amount))
    )
  );

  socket.on(
    'respondOffer',
    withRoom((room, playerId, { accept }) => room.respondOffer(playerId, !!accept))
  );

  socket.on(
    'declareShowdown',
    withRoom((room, playerId) => room.declareShowdown(playerId))
  );

  socket.on(
    'nextRound',
    withRoom((room, playerId) => {
      if (room.hostId !== playerId) throw new Error('فقط صاحب الغرفة يقدر يبدأ الجولة القادمة');
      room.continueToNextRound();
    })
  );

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.code);
    if (room) {
      // ما نحذف اللاعب ولا الغرفة فورًا — ممكن يكون انقطاع مؤقت
      // (مثلاً بدّل تطبيقات بجواله لحظة). نعلّمه بس كغير متصل،
      // وتنظيف الغرف المهجورة فعليًا يصير بشكل دوري (انظر sweepAbandonedRooms).
      room.removePlayer(meta.playerId);
      broadcastRoom(room);
    }
    socketMeta.delete(socket.id);
  });
});

// تنظيف دوري للغرف المهجورة تمامًا (كل لاعبينها غير متصلين لفترة طويلة)
// عشان ما تتراكم بالذاكرة، بدون ما نحذف غرفة فيها أي احتمال رجوع لاعب لها.
const ABANDON_AFTER_MS = 30 * 60 * 1000; // 30 دقيقة بدون أي نشاط أو اتصال
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idleFor = now - (room.lastActivity || 0);
    if (idleFor > ABANDON_AFTER_MS && !room.hasAnyConnectedPlayer()) {
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`مداقش يعمل الآن على المنفذ ${PORT}`);
});
