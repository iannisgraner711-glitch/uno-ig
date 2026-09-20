const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const rooms = {};

// Helper: Generate Deck based on game modes
function createDeck(moreCards = false) {
  const colors = ['Red', 'Blue', 'Green', 'Yellow'];
  const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
  let deck = [];

  colors.forEach(color => {
    values.forEach(val => {
      deck.push({ color, value: val, id: Math.random().toString(36).substr(2, 9) });
      if (val !== '0') {
        deck.push({ color, value: val, id: Math.random().toString(36).substr(2, 9) });
      }
    });
  });

  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'Wild', value: 'Wild', id: Math.random().toString(36).substr(2, 9) });
    deck.push({ color: 'Wild', value: '+4', id: Math.random().toString(36).substr(2, 9) });
  }

  // Rare & Mythic Cards
  if (moreCards) {
    const rareCards = ['Roulette', 'Spy', 'Shield', 'TaxCollector'];
    rareCards.forEach(value => {
      for (let i = 0; i < 2; i++) {
        deck.push({ color: 'Wild', value, rarity: 'rare', id: Math.random().toString(36).substr(2, 9) });
      }
    });

    const mythicCards = ['+25', 'Reset', 'Domain', 'Reflect'];
    mythicCards.forEach(value => {
      deck.push({ color: 'Wild', value, rarity: 'mythic', id: Math.random().toString(36).substr(2, 9) });
    });
  }

  // Shuffle Deck
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

// Helper: Draw Card for Player with auto-reshuffle
function drawCardForPlayer(room, player) {
  if (room.deck.length === 0) {
    if (room.discardPile.length <= 1) return;
    const top = room.discardPile.pop();
    room.deck = room.discardPile.map(c => ({
      ...c,
      color: c.originalColor || c.color
    }));
    room.discardPile = [top];

    for (let i = room.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }
  }

  const card = room.deck.pop();
  if (card) player.cards.push(card);
}

// Helper: Add Card to Discard Pile
function addCardToPile(room, card) {
  room.discardPile.push({
    ...card,
    rot: Math.floor(Math.random() * 60) - 30,
    offsetX: Math.floor(Math.random() * 20) - 10,
    offsetY: Math.floor(Math.random() * 20) - 10
  });
}

// Helper: Get Active Non-Finished Connected Players
function getActivePlayers(room) {
  return room.players.filter(p => !p.finished && p.connected !== false);
}

// Helper: Advance Turn
function advanceTurn(room, skipSteps = 1) {
  const active = getActivePlayers(room);
  if (active.length <= 1) {
    checkGameOverCondition(room);
    return;
  }

  if (room.domainTurns > 0) {
    room.domainTurns--;
    if (room.domainTurns <= 0) room.domainColor = null;
  }

  room.players.forEach(p => {
    if (p.spyTurns > 0) p.spyTurns--;
  });

  let nextIdx = room.currentTurnIndex;
  for (let i = 0; i < skipSteps; i++) {
    do {
      nextIdx = (nextIdx + room.direction + room.players.length) % room.players.length;
    } while (room.players[nextIdx].finished || room.players[nextIdx].connected === false);
  }

  room.currentTurnIndex = nextIdx;
  const currPlayer = room.players[room.currentTurnIndex];

  let nextTurnIdx = nextIdx;
  do {
    nextTurnIdx = (nextTurnIdx + room.direction + room.players.length) % room.players.length;
  } while (room.players[nextTurnIdx].finished || room.players[nextTurnIdx].connected === false);

  const nextPlayer = room.players[nextTurnIdx];

  const revealedPlayers = room.players
    .filter(p => p.spyTurns > 0 && !p.finished)
    .map(p => ({ name: p.name, cards: p.cards }));

  io.to(room.code).emit('gameState', {
    discardPile: room.discardPile,
    currentTurn: `${currPlayer.avatar} ${currPlayer.name}`,
    currentSessionId: currPlayer.sessionId,
    nextTurn: `${nextPlayer.avatar} ${nextPlayer.name}`,
    leaderboard: room.leaderboard,
    direction: room.direction,
    stackedDraw: room.stackedDraw,
    gameStarted: room.gameStarted,
    red7Rule: room.red7Rule,
    moreCards: room.moreCards,
    domainColor: room.domainColor,
    domainTurns: room.domainTurns,
    revealedPlayers
  });
}

// Helper: Resolve Red 7 Speed Penalties
function resolveRed7Penalty(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.red7Active) return;

  room.red7Active = false;
  io.to(roomCode).emit('red7Ended');

  const active = getActivePlayers(room);
  const missed = active.filter(p => !room.red7Responded.includes(p.sessionId));

  missed.forEach(p => {
    drawCardForPlayer(room, p);
    io.to(p.socketId).emit('yourHand', p.cards);
    io.to(p.socketId).emit('handPenaltyMsg', '⚠️ Too slow on Red 7! +1 Card Penalty!');
  });

  if (room.red7Responded.length > 0) {
    const slowestSessionId = room.red7Responded[room.red7Responded.length - 1];
    const slowestPlayer = room.players.find(p => p.sessionId === slowestSessionId);
    if (slowestPlayer && active.length > 1) {
      drawCardForPlayer(room, slowestPlayer);
      io.to(slowestPlayer.socketId).emit('yourHand', slowestPlayer.cards);
      io.to(slowestPlayer.socketId).emit('handPenaltyMsg', '⚠️ Last to extend hand on Red 7! +1 Card Penalty!');
    }
  }
}

// Helper: Check Game Over
function checkGameOverCondition(room) {
  const active = getActivePlayers(room);
  if (active.length <= 1) {
    if (active.length === 1) {
      room.leaderboard.push({ sessionId: active[0].sessionId, name: `${active[0].avatar} ${active[0].name}` });
    }
    room.gameStarted = false;
    io.to(room.code).emit('gameOver', room.leaderboard);
    return true;
  }
  return false;
}

// Helper: Emit Lobby Update
function emitLobbyUpdate(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  io.to(roomCode).emit('updateLobby', {
    hostSessionId: room.hostSessionId,
    red7Rule: room.red7Rule,
    moreCards: room.moreCards,
    players: room.players.map(p => ({
      name: p.name,
      avatar: p.avatar,
      sessionId: p.sessionId
    }))
  });
}

// Helper: Broadcast Lobby List
function broadcastLobbies() {
  const lobbyList = Object.keys(rooms)
    .filter(code => !rooms[code].isPrivate && !rooms[code].gameStarted)
    .map(code => ({
      code,
      hasPassword: !!rooms[code].password,
      players: rooms[code].players.length,
      red7Rule: rooms[code].red7Rule,
      moreCards: rooms[code].moreCards
    }));

  io.emit('lobbyList', lobbyList);
}

io.on('connection', (socket) => {
  socket.on('getLobbies', () => broadcastLobbies());

  socket.on('joinRoom', ({ username, roomCode, avatar, sessionId, isPrivate, password }) => {
    socket.username = username;
    socket.roomCode = roomCode;
    socket.avatar = avatar || '😀';
    socket.sessionId = sessionId;

    socket.join(roomCode);

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        code: roomCode,
        hostSessionId: sessionId,
        players: [],
        deck: [],
        discardPile: [],
        currentTurnIndex: 0,
        direction: 1,
        gameStarted: false,
        stackedDraw: 0,
        leaderboard: [],
        red7Rule: false,
        moreCards: false,
        isPrivate: !!isPrivate,
        password: password || null,
        domainColor: null,
        domainTurns: 0
      };
    }

    const room = rooms[roomCode];

    if (room.password && room.password !== password && room.hostSessionId !== sessionId) {
      return socket.emit('errorMsg', 'Incorrect room password!');
    }

    let existingPlayer = room.players.find(p => p.sessionId === sessionId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.connected = true;
      existingPlayer.name = username;
      existingPlayer.avatar = avatar;
    } else {
      if (room.gameStarted) {
        return socket.emit('errorMsg', 'Game already in progress!');
      }
      existingPlayer = {
        socketId: socket.id,
        sessionId,
        name: username,
        avatar,
        cards: [],
        finished: false,
        spyTurns: 0,
        connected: true
      };
      room.players.push(existingPlayer);
    }

    emitLobbyUpdate(roomCode);
    broadcastLobbies();

    if (room.gameStarted) {
      const currP = room.players[room.currentTurnIndex];
      socket.emit('gameState', {
        discardPile: room.discardPile,
        currentTurn: currP ? `${currP.avatar} ${currP.name}` : '--',
        currentSessionId: currP ? currP.sessionId : null,
        nextTurn: '--',
        leaderboard: room.leaderboard,
        direction: room.direction,
        stackedDraw: room.stackedDraw,
        gameStarted: room.gameStarted,
        red7Rule: room.red7Rule,
        moreCards: room.moreCards,
        domainColor: room.domainColor,
        domainTurns: room.domainTurns,
        revealedPlayers: []
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

  socket.on('toggleMoreCards', (enabled) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostSessionId !== socket.sessionId || room.gameStarted) return;
    room.moreCards = enabled;
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
    room.deck = createDeck(room.moreCards);
    room.leaderboard = [];
    room.discardPile = [];
    room.direction = 1;
    room.stackedDraw = 0;
    room.unoCalled = {};
    room.red7Active = false;
    room.red7Responded = [];
    room.domainColor = null;
    room.domainTurns = 0;

    room.players.forEach(p => {
      p.cards = [];
      p.spyTurns = 0;
      for (let i = 0; i < 7; i++) {
        drawCardForPlayer(room, p);
      }
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
      drawCardForPlayer(room, player);
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

  socket.on('debugGiveCard', ({ color, value, rarity }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const player = room.players.find(p => p.sessionId === socket.sessionId);
    if (!player) return;

    const card = { color, value, rarity: rarity || null, id: Math.random().toString(36).substr(2, 9) };
    player.cards.push(card);

    socket.emit('yourHand', player.cards);
    socket.emit('chatMessage', { sender: '🛠️ DEBUG', text: `Given card: [${color} ${value}]` });
  });

  socket.on('playCards', ({ cardIds, chosenColor, targetSessionId }) => {
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

    if (room.domainColor && firstCard.color !== 'Wild' && firstCard.color !== room.domainColor) {
      return socket.emit('chatMessage', { sender: 'System', text: `🌀 Domain Active! You must play ${room.domainColor}!` });
    }

    if (firstCard.value === 'Shield' && room.stackedDraw > 0) {
      cardIds.forEach(id => {
        const idx = player.cards.findIndex(c => c.id === id);
        if (idx !== -1) player.cards.splice(idx, 1);
      });
      addCardToPile(room, firstCard);
      io.to(socket.roomCode).emit('chatMessage', { sender: '🛡️ SHIELD', text: `${player.avatar} ${player.name} blocked $+${room.stackedDraw}$ draw attack!` });
      room.stackedDraw = 0;
      socket.emit('yourHand', player.cards);
      return advanceTurn(room, 1);
    }

    if (room.stackedDraw > 0 && !['+2', '+4', '+25'].includes(firstCard.value)) return;

    const isMatch = firstCard.color === 'Wild' || firstCard.color === top.color || firstCard.value === top.value;
    if (!isMatch && !room.domainColor) return;

    cardIds.forEach(id => {
      const idx = player.cards.findIndex(c => c.id === id);
      if (idx !== -1) player.cards.splice(idx, 1);
    });

    playedCards.forEach((c, index) => {
      if (c.color === 'Wild') c.color = chosenColor || 'Red';
      if (index === playedCards.length - 1 && chosenColor && c.color !== 'Wild') c.color = chosenColor;
      addCardToPile(room, c);
    });

    const isWildPlus = ['+4', '+25'].includes(firstCard.value);
    const isHeavyStack = room.stackedDraw >= 4;

    io.to(socket.roomCode).emit('cardPlayedEvent', {
      isWildPlus4: isWildPlus,
      isHeavyStack,
      cardCount: playedCards.length
    });

    // Custom Cards Logic Engine
    if (firstCard.value === '+25') {
      room.stackedDraw += 25 * playedCards.length;
      io.to(socket.roomCode).emit('chatMessage', { sender: '💣 NUKE', text: `BOOM! $+25$ Nuke played! Stack total: $+${room.stackedDraw}$` });
    } else if (firstCard.value === 'Reset') {
      // FIXED GOLDEN RESET LOGIC
      io.to(socket.roomCode).emit('chatMessage', { sender: '👑 GOLDEN RESET', text: 'All hands discarded and reshuffled! Everyone draws 7 fresh cards!' });
      
      // 1. Collect all cards from active non-finished players back into the deck
      room.players.forEach(p => {
        if (!p.finished) {
          room.deck.push(...p.cards);
          p.cards = [];
        }
      });

      // 2. Return discard pile (except top card) back to deck
      if (room.discardPile.length > 1) {
        const topCard = room.discardPile.pop();
        room.deck.push(...room.discardPile);
        room.discardPile = [topCard];
      }

      // 3. Reshuffle the complete deck
      for (let i = room.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
      }

      // 4. Deal 7 fresh cards to everyone
      room.players.forEach(p => {
        if (!p.finished) {
          for (let i = 0; i < 7; i++) {
            drawCardForPlayer(room, p);
          }
          io.to(p.socketId).emit('yourHand', p.cards);
        }
      });
    } else if (firstCard.value === 'Domain') {
      room.domainColor = chosenColor || 'Red';
      room.domainTurns = 3 * room.players.length;
      io.to(socket.roomCode).emit('chatMessage', { sender: '🌀 DOMAIN EXPANSION', text: `Domain locked to ${room.domainColor} for 3 rounds!` });
    } else if (firstCard.value === 'Reflect' && room.stackedDraw > 0) {
      room.direction *= -1;
      io.to(socket.roomCode).emit('chatMessage', { sender: '🪞 REFLECT', text: `Reflected $+${room.stackedDraw}$ attack back to sender!` });
    } else if (firstCard.value === 'Roulette') {
      const rolled = Math.floor(Math.random() * 6) + 1;
      if (rolled === 1) {
        room.stackedDraw += 10;
        io.to(socket.roomCode).emit('chatMessage', { sender: '🎲 ROULETTE', text: `JACKPOT! Next player faces $+10$ draw penalty!` });
      } else {
        for (let i = 0; i < 3; i++) drawCardForPlayer(room, player);
        io.to(socket.roomCode).emit('chatMessage', { sender: '🎲 ROULETTE', text: `${player.avatar} ${player.name} missed roll and drew 3 cards!` });
      }
    } else if (firstCard.value === 'Spy') {
      const activeTargets = getActivePlayers(room).filter(p => p.sessionId !== player.sessionId);
      const target = activeTargets.find(p => p.sessionId === targetSessionId) || activeTargets[0];
      if (target) {
        target.spyTurns = 2;
        io.to(socket.roomCode).emit('chatMessage', { sender: '👁️ SPY', text: `${target.avatar} ${target.name}'s hand is now exposed for 2 rounds!` });
      }
    } else if (firstCard.value === 'TaxCollector') {
      getActivePlayers(room).forEach(p => {
        if (p.sessionId !== player.sessionId) {
          drawCardForPlayer(room, p);
          io.to(p.socketId).emit('yourHand', p.cards);
        }
      });
      io.to(socket.roomCode).emit('chatMessage', { sender: '💰 TAX COLLECTOR', text: `Tax collected! All other players drew 1 card!` });
    }

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
        drawCardForPlayer(room, player);
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
      drawCardForPlayer(room, player);
    }

    if (player.cards.length > 1) room.unoCalled[player.sessionId] = false;

    io.to(socket.roomCode).emit('cardDrawnEvent', { drawCount });
    socket.emit('yourHand', player.cards);
    advanceTurn(room, 1);
  });

  socket.on('sendChat', (text) => {
    if (!socket.roomCode) return;

    if (text.trim() === '/give 67') {
      return socket.emit('openDebugMenu');
    }

    io.to(socket.roomCode).emit('chatMessage', { sender: `${socket.avatar} ${socket.username}`, text });
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