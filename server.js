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

function createDeck(moreCardsEnabled = false) {
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

  if (moreCardsEnabled) {
    // Custom Rare Cards added into deck
    const customTypes = ['Roulette', 'Spy', 'Shield', 'DoublePlay', 'TaxCollector'];
    customTypes.forEach(type => {
      for (let k = 0; k < 2; k++) {
        deck.push({ color: 'Wild', value: type, rarity: 'rare', id: Math.random().toString(36).substr(2, 9) });
      }
    });
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
      red7Rule: rooms[code].red7Rule,
      moreCards: rooms[code].moreCards
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
  try {
    const room = rooms[roomCode];
    if (!room || !room.gameStarted) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || currentPlayer.finished) return advanceTurn(room, 0);

    const drawAmount = room.stackedDraw > 0 ? room.stackedDraw : 1;
    room.stackedDraw = 0;

    for (let i = 0; i < drawAmount; i++) {
      drawCardForPlayer(room, currentPlayer);
    }

    io.to(currentPlayer.socketId).emit('yourHand', currentPlayer.cards);
    advanceTurn(room, 1);
  } catch (err) {
    console.error('[handleTurnTimeout ERROR]', err);
  }
}

function drawCardForPlayer(room, player) {
  // 0.0001% mythic card draw roll if More Cards setting is ON
  if (room.moreCards && Math.random() < 0.00001) {
    const mythics = [
      { color: 'Wild', value: '+25', rarity: 'mythic' },
      { color: 'Wild', value: 'Reset', rarity: 'mythic' },
      { color: 'Wild', value: 'Domain', rarity: 'mythic' },
      { color: 'Wild', value: 'Reflect', rarity: 'mythic' }
    ];
    const picked = mythics[Math.floor(Math.random() * mythics.length)];
    const card = { ...picked, id: Math.random().toString(36).substr(2, 9) };
    player.cards.push(card);
    io.to(room.roomCode).emit('chatMessage', {
      sender: '🌟 MYTHIC DRAW!',
      text: `${player.avatar} ${player.name} pulled a 0.0001% MYTHIC ${card.value} CARD!`
    });
    return card;
  }

  if (room.deck.length === 0) room.deck = createDeck(room.moreCards);
  const c = room.deck.pop();
  player.cards.push(c);
  return c;
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
    console.log(`[GAME OVER DEBUG] Room ${room.roomCode} ended. Total players: ${room.players.length}, Active: ${activePlayers.length}`);
    console.log(`[GAME OVER DEBUG] Player states:`, room.players.map(p => ({ name: p.name, sessionId: p.sessionId, finished: p.finished, cards: p.cards.length })));
    io.to(room.roomCode).emit('gameOver', room.leaderboard);
    return true;
  }
  return false;
}

function advanceTurn(room, steps = 1) {
  try {
    const total = room.players.length;
    if (total === 0 || checkGameOverCondition(room)) return;

    if (room.domainTurns > 0) {
      room.domainTurns--;
      if (room.domainTurns === 0) {
        room.domainColor = null;
        io.to(room.roomCode).emit('chatMessage', { sender: 'System', text: '🌀 Domain Expansion lock has ended!' });
      }
    }

    for (let i = 0; i < steps; i++) {
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

    // Manage Spy visibility expiration
    room.players.forEach(p => {
      if (p.spyTurns > 0) {
        p.spyTurns--;
        if (p.spyTurns === 0) {
          io.to(room.roomCode).emit('chatMessage', { sender: 'System', text: `👁️ ${p.avatar} ${p.name}'s hand is hidden again.` });
        }
      }
    });

    const revealedPlayers = room.players
      .filter(p => p.spyTurns > 0 && !p.finished)
      .map(p => ({ sessionId: p.sessionId, cards: p.cards }));

    io.to(room.roomCode).emit('gameState', {
      discardPile: room.discardPile,
      currentTurn: `${currP.avatar} ${currP.name}`,
      currentSessionId: currP.sessionId,
      nextTurn: `${nextP.avatar} ${nextP.name}`,
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

    startTurnTimer(room.roomCode);
  } catch (err) {
    console.error('[advanceTurn ERROR]', err);
  }
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
    red7Rule: room.red7Rule,
    moreCards: room.moreCards
  });
}

function resolveRed7Penalty(roomCode) {
  try {
    const room = rooms[roomCode];
    if (!room || !room.red7Active) return;

    room.red7Active = false;
    const activePlayers = getActivePlayers(room);

    const missing = activePlayers.filter(p => !room.red7Responded.includes(p.sessionId));

    let loser = null;
    if (missing.length > 0) {
      loser = missing[0];
    } else if (room.red7Responded.length > 0) {
      const loserSessionId = room.red7Responded[room.red7Responded.length - 1];
      loser = room.players.find(p => p.sessionId === loserSessionId);
    }

    if (loser) {
      for (let i = 0; i < 7; i++) {
        drawCardForPlayer(room, loser);
      }
      io.to(loser.socketId).emit('yourHand', loser.cards);
      io.to(roomCode).emit('chatMessage', {
        sender: 'System',
        text: `🔥 RED 7 PENALTY! ${loser.avatar} ${loser.name} extended hand LAST and drew 7 cards!`
      });
    }

    io.to(roomCode).emit('red7Ended');
  } catch (err) {
    console.error('[resolveRed7Penalty ERROR]', err);
  }
}

io.on('connection', (socket) => {
  socket.on('getLobbies', () => broadcastLobbies());

  socket.on('joinRoom', ({ username, roomCode, avatar, sessionId, isPrivate, password, red7Rule, moreCards }) => {
    try {
      if (!rooms[roomCode]) {
        rooms[roomCode] = {
          hostSessionId: sessionId,
          players: [], gameStarted: false, deck: [], discardPile: [],
          currentTurnIndex: 0, leaderboard: [], direction: 1, timer: null, timeLeft: 30, roomCode,
          stackedDraw: 0, unoCalled: {},
          isPrivate: !!isPrivate,
          password: password || null,
          red7Rule: red7Rule !== undefined ? red7Rule : true,
          moreCards: moreCards !== undefined ? moreCards : true,
          red7Active: false,
          red7Responded: [],
          red7Timer: null,
          domainColor: null,
          domainTurns: 0
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

        existingPlayer = {
          sessionId, socketId: socket.id, name: socket.username, avatar: socket.avatar,
          cards: [], finished: false, connected: true, spyTurns: 0
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
    } catch (err) {
      console.error('[joinRoom ERROR]', err);
      socket.emit('errorMsg', 'Something went wrong joining that room.');
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
    try {
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
    } catch (err) {
      console.error('[executeGameStart ERROR]', err);
    }
  }

  socket.on('callUno', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.unoCalled[socket.sessionId] = true;
    io.to(socket.roomCode).emit('unoCalledEvent', { sender: `${socket.avatar} ${socket.username}` });
    socket.emit('unoAcknowledged');
  });

  socket.on('extendHand', () => {
    try {
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
    } catch (err) {
      console.error('[extendHand ERROR]', err);
    }
  });

  // Debug Give Card Command handler
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
    try {
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

      if (firstCard.value === 'Reset') {
        console.log(`[RESET DEBUG] Triggered by ${player.name} (${player.sessionId}) in room ${socket.roomCode}`);
        console.log(`[RESET DEBUG] Players before reset:`, room.players.map(p => ({ name: p.name, sessionId: p.sessionId, cards: p.cards.length, finished: p.finished })));
      }

      // Domain Expansion color enforcement check
      if (room.domainColor && firstCard.color !== 'Wild' && firstCard.color !== room.domainColor) {
        return socket.emit('chatMessage', { sender: 'System', text: `🌀 Domain Active! You must play ${room.domainColor}!` });
      }

      // Shield Counter check against stacked draws
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
        io.to(socket.roomCode).emit('chatMessage', { sender: '👑 GOLDEN RESET', text: 'All hands discarded and reshuffled! Everyone draws 7 fresh cards!' });
        room.players.forEach(p => {
          if (!p.finished) {
            p.cards = [];
            for (let i = 0; i < 7; i++) drawCardForPlayer(room, p);
            io.to(p.socketId).emit('yourHand', p.cards);
            // FIX: clear stale UNO flags since everyone's hand size just changed
            room.unoCalled[p.sessionId] = false;
          }
        });
        console.log(`[RESET DEBUG] Players after reset:`, room.players.map(p => ({ name: p.name, sessionId: p.sessionId, cards: p.cards.length, finished: p.finished })));
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
    } catch (err) {
      console.error('[playCards ERROR]', err);
      socket.emit('chatMessage', { sender: 'System', text: '⚠️ Something went wrong processing that play. Check server logs.' });
    }
  });

  socket.on('drawCard', () => {
    try {
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
    } catch (err) {
      console.error('[drawCard ERROR]', err);
    }
  });

  socket.on('sendChat', (text) => {
    if (!socket.roomCode) return;

    // Secret Debug Menu Command
    if (text.trim() === '/give 67') {
      return socket.emit('openDebugMenu');
    }

    io.to(socket.roomCode).emit('chatMessage', { sender: `${socket.avatar} ${socket.username}`, text });
  });

  socket.on('sendEmoji', (emoji) => {
    if (socket.roomCode) io.to(socket.roomCode).emit('displayEmoji', { sender: `${socket.avatar} ${socket.username}`, emoji });
  });

  socket.on('disconnect', () => {
    try {
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
                // steps must be >=1 here — advanceTurn(room, 0) never moves
                // currentTurnIndex off the now-finished player, which is
                // what caused the game to freeze on disconnect.
                advanceTurn(room, 1);
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
    } catch (err) {
      console.error('[disconnect ERROR]', err);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));