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
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function broadcastLobbies() {
  const list = Object.keys(rooms)
    .filter(code => {
      const r = rooms[code];
      return !r.isPrivate && !r.gameStarted && r.players.length < 12;
    })
    .map(code => ({
      code,
      players: rooms[code].players.length,
      hasPassword: !!rooms[code].password,
      red7Rule: rooms[code].red7Rule
    }));

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
  if (!currentPlayer || currentPlayer.finished) return advanceTurn(room, 0);

  const drawAmount = room.stackedDraw > 0 ? room.stackedDraw : 1;
  room.stackedDraw = 0;

  for (let i = 0; i < drawAmount; i++) {
    if (room.deck.length === 0) room.deck = createDeck();
    currentPlayer.cards.push(room.deck.pop());
  }

  io.to(currentPlayer.socketId).emit('yourHand', currentPlayer.cards);
  advanceTurn(room, 1);
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.finished);
}

function checkGameOverCondition(room) {
  const activePlayers = getActivePlayers(room);
  if (activePlayers.length <= 1) {
    if (room.timer) clearInterval(room.timer);
    if (activePlayers.length === 1) {
      room.leaderboard.push({
        sessionId: activePlayers[0].sessionId,
        name: `${activePlayers[0].avatar} ${activePlayers[0].name}`
      });
    }
    io.to(room.roomCode).emit('gameOver', room.leaderboard);
    return true;
  }
  return false;
}

function advanceTurn(room, steps = 1) {
  const total = room.players.length;
  if (total === 0 || checkGameOverCondition(room)) return;

  for (let i = 0; i < steps; i++) {
    do {
      room.currentTurnIndex = (room.currentTurnIndex + room.direction + total) % total;
    } while (room.players[room.currentTurnIndex].finished);
  }

  if (room.players[room.currentTurnIndex].finished) {
    do {
      room.currentTurnIndex = (room.currentTurnIndex + room.direction + total) % total;
    } while (room.players[room.currentTurnIndex].finished);
  }

  let nextIdx = (room.currentTurnIndex + room.direction + total) % total;
  while (room.players[nextIdx].finished) {
    nextIdx = (nextIdx + room.direction + total) % total;
  }

  const currP = room.players[room.currentTurnIndex];
  const nextP = room.players[nextIdx];

  io.to(room.roomCode).emit('gameState', {
    discardPile: room.discardPile,
    currentTurn: `${currP.avatar} ${currP.name}`,
    currentSessionId: currP.sessionId,
    nextTurn: `${nextP.avatar} ${nextP.name}`,
    leaderboard: room.leaderboard,
    direction: room.direction,
    stackedDraw: room.stackedDraw,
    gameStarted: room.gameStarted,
    red7Rule: room.red7Rule
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
    hostSessionId: room.hostSessionId,
    gameStarted: room.gameStarted,
    isPrivate: room.isPrivate,
    hasPassword: !!room.password,
    red7Rule: room.red7Rule
  });
}

function resolveRed7Penalty(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.red7Active) return;

  room.red7Active = false;
  const activePlayers = getActivePlayers(room);
  
  // Find active players who did NOT extend hand
  const missing = activePlayers.filter(p => !room.red7Responded.includes(p.sessionId));

  let loser = null;
  if (missing.length > 0) {
    // If some players didn't extend, pick the first one missing
    loser = missing[0];
  } else if (room.red7Responded.length > 0) {
    // Last person to extend their hand loses
    const loserSessionId = room.red7Responded[room.red7Responded.length - 1];
    loser = room.players.find(p => p.sessionId === loserSessionId);
  }

  if (loser) {
    for (let i = 0; i < 7; i++) {
      if (room.deck.length === 0) room.deck = createDeck();
      loser.cards.push(room.deck.pop());
    }
    io.to(loser.socketId).emit('yourHand', loser.cards);
    io.to(roomCode).emit('chatMessage', { 
      sender: 'System', 
      text: `🔥 RED 7 PENALTY! ${loser.avatar} ${loser.name} extended hand LAST and drew 7 cards!` 
    });
  }

  io.to(roomCode).emit('red7Ended');
}

io.on('connection', (socket) => {
  socket.on('getLobbies', () => broadcastLobbies());

  socket.on('joinRoom', ({ username, roomCode, avatar, sessionId, isPrivate, password, red7Rule }) => {
    if (!rooms[roomCode]) {
      rooms[roomCode] = { 
        hostSessionId: sessionId,
        players: [], gameStarted: false, deck: [], discardPile: [], 
        currentTurnIndex: 0, leaderboard: [], direction: 1, timer: null, timeLeft: 30, roomCode,
        stackedDraw: 0, unoCalled: {},
        isPrivate: !!isPrivate,
        password: password || null,
        red7Rule: red7Rule !== undefined ? red7Rule : true,
        red7Active: false,
        red7Responded: [],
        red7Timer: null
      };
    }

    const room = rooms[roomCode];

    if (room.password && room.hostSessionId !== sessionId && room.password !== password) {
      return socket.emit('errorMsg', 'Incorrect room password!');
    }

    const finalName = username ? username.trim() : "Player_" + Math.floor(Math.random() * 899 + 100);

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = finalName;
    socket.avatar = avatar || '🤠';
    socket.sessionId = sessionId;

    let existingPlayer = room.players.find(p => p.sessionId === sessionId);

    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.connected = true;
      existingPlayer.name = socket.username;
      existingPlayer.avatar = socket.avatar;
    } else {
      if (room.players.length >= 12) return socket.emit('errorMsg', 'Room full (12 max).');
      if (room.gameStarted) return socket.emit('errorMsg', 'Game in progress.');

      existingPlayer = { sessionId, socketId: socket.id, name: socket.username, avatar: socket.avatar, cards: [], finished: false, connected: true };
      room.players.push(existingPlayer);
    }

    emitLobbyUpdate(roomCode);
    broadcastLobbies();

    if (room.gameStarted) {
      let nextIdx = (room.currentTurnIndex + room.direction + room.players.length) % room.players.length;
      while (room.players[nextIdx] && room.players[nextIdx].finished) {
        nextIdx = (nextIdx + room.direction + room.players.length) % room.players.length;
      }

      const currP = room.players[room.currentTurnIndex];
      const nextP = room.players[nextIdx];

      socket.emit('gameState', {
        discardPile: room.discardPile,
        currentTurn: currP ? `${currP.avatar} ${currP.name}` : '--',
        currentSessionId: currP ? currP.sessionId : null,
        nextTurn: nextP ? `${nextP.avatar} ${nextP.name}` : '--',
        leaderboard: room.leaderboard,
        direction: room.direction,
        stackedDraw: room.stackedDraw,
        gameStarted: room.gameStarted,
        red7Rule: room.red7Rule
      });
      socket.emit('yourHand', existingPlayer.cards);
    }
  });

  socket.on('toggleRed7Rule', (enabled) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostSessionId !== socket.sessionId || room.gameStarted) return;
    room.red7Rule = enabled;
    emitLobbyUpdate(socket.roomCode);
  });

  socket.on('kickPlayer', (targetSessionId) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostSessionId !== socket.sessionId || room.gameStarted) return;

    const idx = room.players.findIndex(p => p.sessionId === targetSessionId);
    if (idx !== -1) {
      const kicked = room.players[idx];
      room.players.splice(idx, 1);
      io.to(kicked.socketId).emit('kickedMsg');
      emitLobbyUpdate(socket.roomCode);
      broadcastLobbies();
    }
  });

  socket.on('requestStartGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostSessionId !== socket.sessionId || room.players.length < 2) return;

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
    room.red7Active = false;
    room.red7Responded = [];

    room.players.forEach(p => {
      p.cards = room.deck.splice(0, 7);
      p.finished = false;
      io.to(p.socketId).emit('yourHand', p.cards);
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

  socket.on('callUno', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.unoCalled[socket.sessionId] = true;
    io.to(socket.roomCode).emit('unoCalledEvent', { sender: `${socket.avatar} ${socket.username}` });
    socket.emit('unoAcknowledged');
  });

  socket.on('extendHand', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const player = room.players.find(p => p.sessionId === socket.sessionId);
    if (!player || player.finished) return;

    if (!room.red7Rule || !room.red7Active) {
      // FALSE ALARM PENALTY (+1 Card)
      if (room.deck.length === 0) room.deck = createDeck();
      player.cards.push(room.deck.pop());
      socket.emit('yourHand', player.cards);
      socket.emit('handPenaltyMsg', '⚠️ False Hand Extension! +1 Card Penalty!');
      io.to(socket.roomCode).emit('chatMessage', { 
        sender: 'System', 
        text: `⚠️ ${player.avatar} ${player.name} extended hand on a non-Red 7! +1 Card Penalty!` 
      });
      return;
    }

    if (!room.red7Responded.includes(socket.sessionId)) {
      room.red7Responded.push(socket.sessionId);
      io.to(socket.roomCode).emit('handExtendedEvent', { 
        sessionId: socket.sessionId, 
        avatar: player.avatar, 
        name: player.name,
        order: room.red7Responded.length
      });

      const activePlayers = getActivePlayers(room);
      if (room.red7Responded.length === activePlayers.length) {
        if (room.red7Timer) clearTimeout(room.red7Timer);
        resolveRed7Penalty(socket.roomCode);
      }
    }
  });

  socket.on('playCards', ({ cardIds, chosenColor }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const player = room.players[room.currentTurnIndex];
    if (player.sessionId !== socket.sessionId || player.finished) return;
    if (!cardIds || cardIds.length === 0) return;

    const playedCards = player.cards.filter(card => cardIds.includes(card.id));
    if (playedCards.length !== cardIds.length) return;

    const targetValue = playedCards[0].value;
    if (!playedCards.every(c => c.value === targetValue)) return;

    const top = room.discardPile[room.discardPile.length - 1];
    const firstCard = playedCards[0];

    if (room.stackedDraw > 0 && firstCard.value !== '+2' && firstCard.value !== '+4') return;

    const isMatch = firstCard.color === 'Wild' || firstCard.color === top.color || firstCard.value === top.value;
    if (!isMatch) return;

    cardIds.forEach(id => {
      const idx = player.cards.findIndex(c => c.id === id);
      if (idx !== -1) player.cards.splice(idx, 1);
    });

    playedCards.forEach((c, index) => {
      if (c.color === 'Wild') c.color = chosenColor || 'Red';
      if (index === playedCards.length - 1 && chosenColor && c.color !== 'Wild') c.color = chosenColor;
      addCardToPile(room, c);
    });

    const isWildPlus4 = playedCards.some(c => c.value === '+4');
    const isHeavyStack = room.stackedDraw >= 4;

    io.to(socket.roomCode).emit('cardPlayedEvent', {
      isWildPlus4,
      isHeavyStack,
      cardCount: playedCards.length
    });

    // Check for RED 7
    const playedRed7 = playedCards.some(c => c.color === 'Red' && c.value === '7');
    if (room.red7Rule && playedRed7) {
      room.red7Active = true;
      room.red7Responded = [];
      io.to(socket.roomCode).emit('red7Triggered');

      if (room.red7Timer) clearTimeout(room.red7Timer);
      room.red7Timer = setTimeout(() => {
        resolveRed7Penalty(socket.roomCode);
      }, 3000);
    }

    if (player.cards.length === 1) {
      if (!room.unoCalled[player.sessionId]) {
        if (room.deck.length === 0) room.deck = createDeck();
        player.cards.push(room.deck.pop());
        io.to(socket.roomCode).emit('chatMessage', { sender: 'System', text: `⚠️ ${player.avatar} ${player.name} forgot to call UNO! +1 Card Penalty!` });
      }
    } else if (player.cards.length > 1) {
      room.unoCalled[player.sessionId] = false;
    }

    const lastCard = playedCards[playedCards.length - 1];
    if (player.cards.length === 0) {
      player.finished = true;
      room.leaderboard.push({ sessionId: player.sessionId, name: `${player.avatar} ${player.name}` });
    }

    if (checkGameOverCondition(room)) return;

    let skipSteps = 1;
    if (lastCard.value === 'Reverse') room.direction *= -1;
    if (lastCard.value === 'Skip') skipSteps = 2;

    if (lastCard.value === '+2' || lastCard.value === '+4') {
      room.stackedDraw += (lastCard.value === '+2' ? 2 : 4) * playedCards.length;
    }

    socket.emit('yourHand', player.cards);
    advanceTurn(room, skipSteps);
  });

  socket.on('drawCard', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const player = room.players[room.currentTurnIndex];
    if (player.sessionId !== socket.sessionId || player.finished) return;

    const drawCount = room.stackedDraw > 0 ? room.stackedDraw : 1;
    room.stackedDraw = 0;

    for (let i = 0; i < drawCount; i++) {
      if (room.deck.length === 0) room.deck = createDeck();
      player.cards.push(room.deck.pop());
    }

    if (player.cards.length > 1) room.unoCalled[player.sessionId] = false;

    io.to(socket.roomCode).emit('cardDrawnEvent', { drawCount });
    socket.emit('yourHand', player.cards);
    advanceTurn(room, 1);
  });

  socket.on('sendChat', (text) => {
    if (socket.roomCode) io.to(socket.roomCode).emit('chatMessage', { sender: `${socket.avatar} ${socket.username}`, text });
  });

  socket.on('sendEmoji', (emoji) => {
    if (socket.roomCode) io.to(socket.roomCode).emit('displayEmoji', { sender: `${socket.avatar} ${socket.username}`, emoji });
  });

  socket.on('disconnect', () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      const room = rooms[socket.roomCode];
      const player = room.players.find(p => p.sessionId === socket.sessionId);

      if (player) {
        player.connected = false;

        if (room.gameStarted) {
          if (!player.finished) {
            player.finished = true;
            io.to(socket.roomCode).emit('chatMessage', { sender: 'System', text: `🚪 ${player.avatar} ${player.name} went offline and forfeited!` });

            if (getActivePlayers(room).length <= 1) {
              checkGameOverCondition(room);
            } else if (room.players[room.currentTurnIndex].sessionId === player.sessionId) {
              advanceTurn(room, 0);
            }
          }
        } else {
          room.players = room.players.filter(p => p.sessionId !== socket.sessionId);
          if (room.hostSessionId === socket.sessionId && room.players.length > 0) {
            room.hostSessionId = room.players[0].sessionId;
          }
          emitLobbyUpdate(socket.roomCode);
        }

        if (getActivePlayers(room).length === 0) {
          if (room.timer) clearInterval(room.timer);
          if (room.red7Timer) clearTimeout(room.red7Timer);
          delete rooms[socket.roomCode];
        }
        
        broadcastLobbies();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));