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

  io.to(currentPlayer.socketId).emit('yourHand', currentPlayer.cards);
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
    gameStarted: room.gameStarted
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
    gameStarted: room.gameStarted
  });
}

io.on('connection', (socket) => {

  socket.on('getLobbies', () => {
    broadcastLobbies();
  });

  socket.on('joinRoom', ({ username, roomCode, avatar, sessionId }) => {
    if (!rooms[roomCode]) {
      rooms[roomCode] = { 
        hostSessionId: sessionId,
        players: [], gameStarted: false, deck: [], discardPile: [], 
        currentTurnIndex: 0, leaderboard: [], direction: 1, timer: null, timeLeft: 30, roomCode,
        stackedDraw: 0, unoCalled: {}
      };
    }

    const room = rooms[roomCode];
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username;
    socket.sessionId = sessionId;

    let existingPlayer = room.players.find(p => p.sessionId === sessionId);

    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.connected = true;
      if (username) existingPlayer.name = username;
      if (avatar) existingPlayer.avatar = avatar;
      if (existingPlayer.disconnectTimeout) {
        clearTimeout(existingPlayer.disconnectTimeout);
        existingPlayer.disconnectTimeout = null;
      }
    } else {
      if (room.players.length >= 12) return socket.emit('errorMsg', 'Room full (12 max).');
      if (room.gameStarted) return socket.emit('errorMsg', 'Game in progress.');

      existingPlayer = { 
        sessionId, 
        socketId: socket.id, 
        name: username, 
        avatar: avatar || '🤠', 
        cards: [], 
        finished: false, 
        connected: true 
      };
      room.players.push(existingPlayer);
    }

    emitLobbyUpdate(roomCode);
    broadcastLobbies();

    if (room.gameStarted) {
      socket.emit('gameState', {
        discardPile: room.discardPile,
        currentTurn: room.players[room.currentTurnIndex].name,
        nextTurn: room.players[(room.currentTurnIndex + room.direction + room.players.length) % room.players.length].name,
        leaderboard: room.leaderboard,
        direction: room.direction,
        stackedDraw: room.stackedDraw,
        gameStarted: room.gameStarted
      });
      socket.emit('yourHand', existingPlayer.cards);
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

  // MULTI-CARD STACK PLAYING MECHANIC
  socket.on('playCards', ({ cardIds, chosenColor }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const player = room.players[room.currentTurnIndex];
    if (player.sessionId !== socket.sessionId || player.finished) return;
    if (!cardIds || cardIds.length === 0) return;

    const playedCards = [];
    for (let id of cardIds) {
      const c = player.cards.find(card => card.id === id);
      if (c) playedCards.push(c);
    }

    if (playedCards.length !== cardIds.length) return;

    // VALIDATE MULTI-CARD STACK: ALL CARDS MUST SHARE THE SAME VALUE/NUMBER
    const targetValue = playedCards[0].value;
    const allSameValue = playedCards.every(c => c.value === targetValue);
    if (!allSameValue) return;

    const top = room.discardPile[room.discardPile.length - 1];
    const firstCard = playedCards[0];

    if (room.stackedDraw > 0) {
      if (firstCard.value !== '+2' && firstCard.value !== '+4') return;
    }

    const isMatch = firstCard.color === 'Wild' || 
                    firstCard.color === top.color || 
                    firstCard.value === top.value;

    if (!isMatch) return;

    // REMOVE PLAYED CARDS FROM PLAYER HAND
    cardIds.forEach(id => {
      const idx = player.cards.findIndex(c => c.id === id);
      if (idx !== -1) player.cards.splice(idx, 1);
    });

    // PUSH ALL CARDS TO DISCARD PILE
    playedCards.forEach((c, index) => {
      if (c.color === 'Wild') c.color = chosenColor || 'Red';
      
      // LAST CARD IN STACK DETERMINES COLOR IF CHOSEN
      if (index === playedCards.length - 1 && chosenColor && c.color !== 'Wild') {
        c.color = chosenColor;
      }
      addCardToPile(room, c);
    });

    const lastCard = playedCards[playedCards.length - 1];

    if (player.cards.length === 0) {
      player.finished = true;
      room.leaderboard.push(player.name);
    }

    if (getActivePlayers(room).length <= 1) {
      if (room.timer) clearInterval(room.timer);
      const last = getActivePlayers(room)[0];
      if (last) room.leaderboard.push(last.name);
      return io.to(socket.roomCode).emit('gameOver', room.leaderboard);
    }

    let skipSteps = 1;
    if (lastCard.value === 'Reverse') room.direction *= -1;
    if (lastCard.value === 'Skip') skipSteps = 2;

    if (lastCard.value === '+2' || lastCard.value === '+4') {
      const penalty = (lastCard.value === '+2' ? 2 : 4) * playedCards.length;
      room.stackedDraw += penalty;
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

    socket.emit('yourHand', player.cards);
    advanceTurn(room, 1);
  });

  socket.on('callUno', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    
    room.unoCalled[socket.sessionId] = true;
    io.to(socket.roomCode).emit('chatMessage', { sender: 'System', text: `🚨 ${socket.username} called UNO!` });
    socket.emit('unoAcknowledged');
  });

  socket.on('catchUno', (targetSessionId) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const target = room.players.find(p => p.sessionId === targetSessionId);
    if (target && target.cards.length === 1 && !room.unoCalled[targetSessionId]) {
      for (let i = 0; i < 2; i++) {
        if (room.deck.length === 0) room.deck = createDeck();
        target.cards.push(room.deck.pop());
      }
      io.to(target.socketId).emit('yourHand', target.cards);
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
      const player = room.players.find(p => p.sessionId === socket.sessionId);

      if (player) {
        player.connected = false;

        // 60-SECOND RECONNECT WINDOW FOR MOBILE REFRESHES
        player.disconnectTimeout = setTimeout(() => {
          room.players = room.players.filter(p => p.sessionId !== socket.sessionId);

          if (room.players.length > 0) {
            if (room.hostSessionId === socket.sessionId) {
              room.hostSessionId = room.players[0].sessionId;
            }
            emitLobbyUpdate(socket.roomCode);
          } else {
            if (room.timer) clearInterval(room.timer);
            delete rooms[socket.roomCode];
          }
          broadcastLobbies();
        }, 60000);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));