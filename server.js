const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = {};

function createDeck() {
  const colors = ['Red', 'Blue', 'Green', 'Yellow'];
  const values = ['0','1','2','3','4','5','6','7','8','9','Skip','Reverse','+2'];
  const deck = [];

  for (let i = 0; i < 2; i++) {
    for (let color of colors) {
      for (let val of values) {
        deck.push({ color, value: val, id: Math.random().toString(36).substr(2, 9) });
      }
    }
    for (let j = 0; j < 4; j++) {
      deck.push({ color: 'Wild', value: 'Wild', id: Math.random().toString(36).substr(2, 9) });
      deck.push({ color: 'Wild', value: '+4', id: Math.random().toString(36).substr(2, 9) });
      deck.push({ color: 'Wild', value: 'Swap', id: Math.random().toString(36).substr(2, 9) });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function broadcastLobbies() {
  const list = Object.keys(rooms).map(code => ({
    code,
    players: rooms[code].players.length,
    started: rooms[code].gameStarted
  })).filter(r => !r.started && r.players < 12);

  io.emit('lobbyList', list);
}

function startTurnTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timer) clearInterval(room.timer);
  room.timeLeft = 30;

  io.to(roomCode).emit('timerUpdate', room.timeLeft);

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomCode).emit('timerUpdate', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      handleTurnTimeout(roomCode);
    }
  }, 1000);
}

function handleTurnTimeout(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.gameStarted) return;

  const currentPlayer = room.players[room.currentTurnIndex];
  const drawAmount = room.stackedDraw > 0 ? room.stackedDraw : 1;
  room.stackedDraw = 0;

  for (let i = 0; i < drawAmount; i++) {
    if (room.deck.length === 0) room.deck = createDeck();
    currentPlayer.cards.push(room.deck.pop());
  }

  io.to(currentPlayer.id).emit('yourHand', currentPlayer.cards);
  advanceTurn(room, 1);
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.finished);
}

function advanceTurn(room, steps = 1) {
  const total = room.players.length;
  if (total === 0) return;

  for (let i = 0; i < steps; i++) {
    do {
      room.currentTurnIndex = (room.currentTurnIndex + room.direction + total) % total;
    } while (room.players[room.currentTurnIndex].finished);
  }

  const nextIdx = (room.currentTurnIndex + room.direction + total) % total;
  let nextPlayer = room.players[nextIdx];

  while (nextPlayer.finished) {
    const tempIdx = (room.players.indexOf(nextPlayer) + room.direction + total) % total;
    nextPlayer = room.players[tempIdx];
  }

  io.to(room.roomCode).emit('gameState', {
    discardPile: room.discardPile,
    currentTurn: room.players[room.currentTurnIndex].name,
    nextTurn: nextPlayer.name,
    leaderboard: room.leaderboard,
    direction: room.direction,
    stackedDraw: room.stackedDraw,
    rules: room.rules
  });

  startTurnTimer(room.roomCode);
}

function addCardToPile(room, card) {
  const rot = Math.floor(Math.random() * 40) - 20;
  const offsetX = Math.floor(Math.random() * 16) - 8;
  const offsetY = Math.floor(Math.random() * 16) - 8;

  room.discardPile.push({ ...card, rot, offsetX, offsetY });
  if (room.discardPile.length > 6) room.discardPile.shift();
}

function emitLobbyUpdate(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit('updateLobby', {
    players: room.players,
    hostId: room.hostId,
    rules: room.rules
  });
}

io.on('connection', (socket) => {

  socket.on('getLobbies', () => {
    broadcastLobbies();
  });

  socket.on('joinRoom', ({ username, roomCode, avatar }) => {
    if (!rooms[roomCode]) {
      rooms[roomCode] = { 
        hostId: socket.id,
        players: [], gameStarted: false, deck: [], discardPile: [], 
        currentTurnIndex: 0, leaderboard: [], direction: 1, timer: null, timeLeft: 30, roomCode,
        stackedDraw: 0, rules: { allowStacking: true, jumpIn: true, '70Rule': true }, unoCalled: {}
      };
    }

    const room = rooms[roomCode];
    if (room.players.length >= 12) return socket.emit('errorMsg', 'Room full (12 max).');
    if (room.gameStarted) return socket.emit('errorMsg', 'Game in progress.');

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username;
    socket.avatar = avatar || '🤠';

    room.players.push({ id: socket.id, name: username, avatar: socket.avatar, cards: [], finished: false });
    emitLobbyUpdate(roomCode);
    broadcastLobbies();
  });

  socket.on('updateRules', (newRules) => {
    const room = rooms[socket.roomCode];
    if (room && room.hostId === socket.id) {
      room.rules = { ...room.rules, ...newRules };
      io.to(socket.roomCode).emit('rulesUpdated', room.rules);
      emitLobbyUpdate(socket.roomCode);
    }
  });

  socket.on('requestStartGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id || room.players.length < 2) return;

    let count = 3;
    const startInterval = setInterval(() => {
      io.to(socket.roomCode).emit('startCountdown', count);
      count--;
      if (count < 0) {
        clearInterval(startInterval);
        executeGameStart(room);
      }
    }, 1000);
  });

  function executeGameStart(room) {
    room.gameStarted = true;
    room.deck = createDeck();
    room.leaderboard = [];
    room.discardPile = [];
    room.direction = 1;
    room.stackedDraw = 0;
    room.unoCalled = {};

    room.players.forEach(p => {
      p.cards = room.deck.splice(0, 7);
      p.finished = false;
      io.to(p.id).emit('yourHand', p.cards);
    });

    let top = room.deck.pop();
    while (top.color === 'Wild' || top.value === '+2' || top.value === 'Skip' || top.value === 'Reverse') {
      room.deck.unshift(top);
      top = room.deck.pop();
    }
    addCardToPile(room, top);

    room.currentTurnIndex = 0;
    broadcastLobbies();
    advanceTurn(room, 0);
  }

  socket.on('playCard', ({ cardId, chosenColor, swapTargetId }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const player = room.players[room.currentTurnIndex];
    const isTurn = player.id === socket.id;
    const playerObj = room.players.find(p => p.id === socket.id);

    if (!playerObj || playerObj.finished) return;

    const idx = playerObj.cards.findIndex(c => c.id === cardId);
    if (idx === -1) return;

    const played = playerObj.cards[idx];
    const top = room.discardPile[room.discardPile.length - 1];

    const isJumpIn = room.rules.jumpIn && !isTurn && played.color === top.color && played.value === top.value;

    if (!isTurn && !isJumpIn) {
      return socket.emit('invalidPlay', cardId);
    }

    if (room.stackedDraw > 0 && room.rules.allowStacking) {
      if (played.value !== '+2' && played.value !== '+4') {
        return socket.emit('invalidPlay', cardId);
      }
    }

    const isMatch = played.color === 'Wild' || 
                    played.color === top.color || 
                    played.value === top.value || isJumpIn;

    if (!isMatch) {
      socket.emit('invalidPlay', cardId);
      return;
    }

    if (isJumpIn) {
      room.currentTurnIndex = room.players.findIndex(p => p.id === socket.id);
    }

    socket.emit('validPlay', cardId);

    if (played.color === 'Wild') played.color = chosenColor || 'Red';

    playerObj.cards.splice(idx, 1);
    addCardToPile(room, played);

    // STRICT CHECK FOR 7-0 HOUSE RULE
    if (room.rules['70Rule']) {
      if (played.value === '0') {
        const lastHand = room.players[room.players.length - 1].cards;
        for (let i = room.players.length - 1; i > 0; i--) {
          room.players[i].cards = room.players[i - 1].cards;
        }
        room.players[0].cards = lastHand;
        room.players.forEach(p => io.to(p.id).emit('yourHand', p.cards));
      } else if (played.value === '7' && swapTargetId) {
        const target = room.players.find(p => p.id === swapTargetId);
        if (target) {
          const temp = playerObj.cards;
          playerObj.cards = target.cards;
          target.cards = temp;
          io.to(target.id).emit('yourHand', target.cards);
        }
      }
    }

    if (played.value === 'Swap' && swapTargetId) {
      const target = room.players.find(p => p.id === swapTargetId);
      if (target) {
        const temp = playerObj.cards;
        playerObj.cards = target.cards;
        target.cards = temp;
        io.to(target.id).emit('yourHand', target.cards);
      }
    }

    if (playerObj.cards.length === 0) {
      playerObj.finished = true;
      room.leaderboard.push(playerObj.name);
    }

    if (getActivePlayers(room).length <= 1) {
      if (room.timer) clearInterval(room.timer);
      const last = getActivePlayers(room)[0];
      if (last) room.leaderboard.push(last.name);
      return io.to(socket.roomCode).emit('gameOver', room.leaderboard);
    }

    let skipSteps = 1;
    if (played.value === 'Reverse') room.direction *= -1;
    if (played.value === 'Skip') skipSteps = 2;

    if (played.value === '+2' || played.value === '+4') {
      const penalty = played.value === '+2' ? 2 : 4;
      if (room.rules.allowStacking) {
        room.stackedDraw += penalty;
      } else {
        room.stackedDraw = penalty;
        skipSteps = 1;
      }
    }

    socket.emit('yourHand', playerObj.cards);
    advanceTurn(room, skipSteps);
  });

  socket.on('drawCard', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const player = room.players[room.currentTurnIndex];
    if (player.id !== socket.id || player.finished) return;

    const drawCount = room.stackedDraw > 0 ? room.stackedDraw : 1;
    room.stackedDraw = 0;

    for (let i = 0; i < drawCount; i++) {
      if (room.deck.length === 0) room.deck = createDeck();
      player.cards.push(room.deck.pop());
    }

    socket.emit('yourHand', player.cards);
    advanceTurn(room, 1);
  });

  // DIRECT UNO CLAIM HANDLER
  socket.on('callUno', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    
    room.unoCalled[socket.id] = true;
    io.to(socket.roomCode).emit('chatMessage', { sender: 'System', text: `🚨 ${socket.username} called UNO!` });
    socket.emit('unoAcknowledged');
  });

  socket.on('catchUno', (targetId) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const target = room.players.find(p => p.id === targetId);
    if (target && target.cards.length === 1 && !room.unoCalled[targetId]) {
      for (let i = 0; i < 2; i++) {
        if (room.deck.length === 0) room.deck = createDeck();
        target.cards.push(room.deck.pop());
      }
      io.to(target.id).emit('yourHand', target.cards);
      io.to(socket.roomCode).emit('chatMessage', { sender: 'System', text: `🎯 ${socket.username} caught ${target.name} for not calling UNO! +2 cards!` });
    }
  });

  socket.on('sendChat', (text) => {
    if (socket.roomCode) {
      io.to(socket.roomCode).emit('chatMessage', { sender: socket.username, text });
    }
  });

  socket.on('sendEmoji', (emoji) => {
    if (socket.roomCode) {
      io.to(socket.roomCode).emit('displayEmoji', { username: socket.username, emoji });
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      const room = rooms[socket.roomCode];
      room.players = room.players.filter(p => p.id !== socket.id);

      if (room.players.length > 0) {
        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
        }
        emitLobbyUpdate(socket.roomCode);
      } else {
        delete rooms[socket.roomCode];
      }
      broadcastLobbies();
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));