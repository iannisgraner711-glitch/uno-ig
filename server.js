const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for rooms
const rooms = new Map();

/* --- CARD DECK GENERATOR --- */
function generateDeck(includeMoreCards = false) {
  const colors = ['Red', 'Blue', 'Green', 'Yellow'];
  const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
  const deck = [];
  let idCounter = 1;

  // Standard Colored Cards
  colors.forEach(color => {
    values.forEach(val => {
      const count = val === '0' ? 1 : 2;
      for (let i = 0; i < count; i++) {
        deck.push({ id: `card_${idCounter++}`, color, value: val, rarity: null });
      }
    });
  });

  // Standard Wild Cards
  for (let i = 0; i < 4; i++) {
    deck.push({ id: `card_${idCounter++}`, color: 'Wild', value: 'Wild', rarity: null });
    deck.push({ id: `card_${idCounter++}`, color: 'Wild', value: '+4', rarity: null });
  }

  // Rare & Mythic Cards ("More Cards" Mode)
  if (includeMoreCards) {
    // Rare Cards
    const rareTypes = ['Roulette', 'Spy', 'Shield', 'TaxCollector'];
    rareTypes.forEach(type => {
      for (let i = 0; i < 2; i++) {
        deck.push({ id: `card_${idCounter++}`, color: 'Wild', value: type, rarity: 'rare' });
      }
    });

    // 0.0001% Mythic Cards
    const mythicTypes = ['+25', 'Reset', 'Domain', 'Reflect'];
    mythicTypes.forEach(type => {
      deck.push({ id: `card_${idCounter++}`, color: 'Wild', value: type, rarity: 'mythic' });
    });
  }

  // Shuffle (Fisher-Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

/* --- ROOM FACTORY --- */
function createRoom(code, password = '', isPrivate = false) {
  return {
    code,
    password,
    isPrivate,
    hostSessionId: null,
    players: [], // Array of { socketId, sessionId, name, avatar, hand: [], calledUno: false }
    red7Rule: false,
    moreCards: false,
    inGame: false,
    deck: [],
    discardPile: [],
    turnIndex: 0,
    direction: 1, // 1 = clockwise, -1 = counter-clockwise
    stackedDraw: 0,
    domainColor: null,
    domainTurns: 0,
    revealedPlayers: [], // Players whose hands are exposed via Spy card
    timer: null,
    secondsLeft: 30,
    red7Active: false,
    red7Slapped: [] // Track session IDs during Red 7 event
  };
}

/* --- GAME HELPER FUNCTIONS --- */
function getNextTurnIndex(room, step = 1) {
  const total = room.players.length;
  if (total === 0) return 0;
  return (room.turnIndex + (room.direction * step) % total + total) % total;
}

function advanceTurn(room, skipCount = 0) {
  room.turnIndex = getNextTurnIndex(room, 1 + skipCount);
  
  if (room.domainTurns > 0) {
    room.domainTurns--;
    if (room.domainTurns === 0) room.domainColor = null;
  }

  // Clear 1-turn Spy reveals
  if (room.revealedPlayers.length > 0) {
    room.revealedPlayers = [];
  }

  resetTurnTimer(room);
}

function resetTurnTimer(room) {
  if (room.timer) clearInterval(room.timer);
  room.secondsLeft = 30;

  io.to(room.code).emit('timerUpdate', room.secondsLeft);

  room.timer = setInterval(() => {
    room.secondsLeft--;
    io.to(room.code).emit('timerUpdate', room.secondsLeft);

    if (room.secondsLeft <= 0) {
      clearInterval(room.timer);
      handleTimeoutDraw(room);
    }
  }, 1000);
}

function handleTimeoutDraw(room) {
  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer) return;

  const cardsToDraw = room.stackedDraw > 0 ? room.stackedDraw : 1;
  room.stackedDraw = 0;

  drawCardsForPlayer(room, currentPlayer, cardsToDraw);
  io.to(currentPlayer.socketId).emit('handPenaltyMsg', `⏱️ Time expired! You drew ${cardsToDraw} card(s).`);
  
  advanceTurn(room);
  broadcastGameState(room);
}

function drawCardsForPlayer(room, player, count) {
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) {
      if (room.discardPile.length > 1) {
        const topCard = room.discardPile.pop();
        room.deck = room.discardPile.map(c => ({ ...c }));
        room.discardPile = [topCard];
        // Shuffle recycled deck
        room.deck.sort(() => Math.random() - 0.5);
      } else {
        break; // No cards left anywhere
      }
    }
    player.hand.push(room.deck.pop());
  }
  io.to(player.socketId).emit('cardDrawnEvent');
  io.to(player.socketId).emit('yourHand', player.hand);
}

function broadcastGameState(room) {
  if (!room.inGame) return;

  const currentP = room.players[room.turnIndex];
  const nextP = room.players[getNextTurnIndex(room, 1)];

  const publicState = {
    currentTurn: currentP ? `${currentP.avatar} ${currentP.name}` : '--',
    nextTurn: nextP ? `${nextP.avatar} ${nextP.name}` : '--',
    stackedDraw: room.stackedDraw,
    domainColor: room.domainColor,
    domainTurns: room.domainTurns,
    direction: room.direction,
    discardPile: room.discardPile.slice(-5), // Last 5 cards for stack rendering
    revealedPlayers: room.revealedPlayers
  };

  io.to(room.code).emit('gameState', publicState);

  // Send private hands to each connected socket
  room.players.forEach(p => {
    io.to(p.socketId).emit('yourHand', p.hand);
  });
}

function broadcastLobbyUpdate(room) {
  io.to(room.code).emit('updateLobby', {
    hostSessionId: room.hostSessionId,
    red7Rule: room.red7Rule,
    moreCards: room.moreCards,
    players: room.players.map(p => ({
      sessionId: p.sessionId,
      name: p.name,
      avatar: p.avatar
    }))
  });
}

function triggerRed7Event(room) {
  room.red7Active = true;
  room.red7Slapped = [];
  io.to(room.code).emit('red7Triggered');

  setTimeout(() => {
    if (!room.red7Active) return;

    // Find players who failed to hit extend hand
    const unslapped = room.players.filter(p => !room.red7Slapped.includes(p.sessionId));
    
    unslapped.forEach(p => {
      drawCardsForPlayer(room, p, 2);
      io.to(p.socketId).emit('handPenaltyMsg', '🔥 You failed to Extend Hand in time during Red 7! (+2 Penalty)');
    });

    room.red7Active = false;
    io.to(room.code).emit('red7Ended');
    broadcastGameState(room);
  }, 3500);
}

/* --- SOCKET EVENTS --- */
io.on('connection', (socket) => {
  let currentRoomCode = null;
  let userSessionId = null;

  // LOBBY BROWSER
  socket.on('getLobbies', () => {
    const list = [];
    rooms.forEach(r => {
      if (!r.isPrivate && !r.inGame) {
        list.push({
          code: r.code,
          players: r.players.length,
          hasPassword: !!r.password,
          red7Rule: r.red7Rule,
          moreCards: r.moreCards
        });
      }
    });
    socket.emit('lobbyList', list);
  });

  // JOIN / CREATE ROOM
  socket.on('joinRoom', ({ username, roomCode, avatar, sessionId, isPrivate, password }) => {
    let room = rooms.get(roomCode);

    if (!room) {
      room = createRoom(roomCode, password, isPrivate);
      room.hostSessionId = sessionId;
      rooms.set(roomCode, room);
    } else {
      if (room.password && room.password !== password) {
        return socket.emit('errorMsg', 'Incorrect room password!');
      }
      if (room.inGame) {
        return socket.emit('errorMsg', 'Game is already in progress!');
      }
      if (room.players.length >= 12) {
        return socket.emit('errorMsg', 'Room is full!');
      }
    }

    currentRoomCode = roomCode;
    userSessionId = sessionId;
    socket.join(roomCode);

    // Reconnection or existing session check
    let existingPlayer = room.players.find(p => p.sessionId === sessionId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.name = username || existingPlayer.name;
      existingPlayer.avatar = avatar || existingPlayer.avatar;
    } else {
      room.players.push({
        socketId: socket.id,
        sessionId,
        name: username || 'Player',
        avatar: avatar || '🤠',
        hand: [],
        calledUno: false
      });
    }

    broadcastLobbyUpdate(room);
  });

  // HOST SETTINGS TOGGLES
  socket.on('toggleRed7Rule', (enabled) => {
    const room = rooms.get(currentRoomCode);
    if (room && room.hostSessionId === userSessionId) {
      room.red7Rule = !!enabled;
      broadcastLobbyUpdate(room);
    }
  });

  socket.on('toggleMoreCards', (enabled) => {
    const room = rooms.get(currentRoomCode);
    if (room && room.hostSessionId === userSessionId) {
      room.moreCards = !!enabled;
      broadcastLobbyUpdate(room);
    }
  });

  // KICK PLAYER
  socket.on('kickPlayer', (targetSessionId) => {
    const room = rooms.get(currentRoomCode);
    if (room && room.hostSessionId === userSessionId && targetSessionId !== userSessionId) {
      const targetPlayer = room.players.find(p => p.sessionId === targetSessionId);
      if (targetPlayer) {
        io.to(targetPlayer.socketId).emit('kickedMsg');
        room.players = room.players.filter(p => p.sessionId !== targetSessionId);
        broadcastLobbyUpdate(room);
      }
    }
  });

  // START GAME
  socket.on('requestStartGame', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostSessionId !== userSessionId || room.inGame) return;

    if (room.players.length < 2) {
      return socket.emit('errorMsg', 'You need at least 2 players to start!');
    }

    let countdown = 3;
    const interval = setInterval(() => {
      io.to(room.code).emit('startCountdown', countdown);
      countdown--;

      if (countdown < 0) {
        clearInterval(interval);
        
        // Initialize Game State
        room.inGame = true;
        room.deck = generateDeck(room.moreCards);
        room.discardPile = [];
        room.turnIndex = 0;
        room.direction = 1;
        room.stackedDraw = 0;

        // Deal 7 cards to each player
        room.players.forEach(p => {
          p.hand = [];
          p.calledUno = false;
          for (let i = 0; i < 7; i++) {
            p.hand.push(room.deck.pop());
          }
        });

        // Initial top card
        let topCard = room.deck.pop();
        while (topCard.color === 'Wild') {
          room.deck.unshift(topCard);
          topCard = room.deck.pop();
        }
        
        topCard.offsetX = (Math.random() - 0.5) * 20;
        topCard.offsetY = (Math.random() - 0.5) * 20;
        topCard.rot = (Math.random() - 0.5) * 40;
        room.discardPile.push(topCard);

        broadcastGameState(room);
        resetTurnTimer(room);
      }
    }, 1000);
  });

  // PLAY CARDS
  socket.on('playCards', ({ cardIds, chosenColor }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.inGame) return;

    const player = room.players[room.turnIndex];
    if (!player || player.socketId !== socket.id) return;

    if (!Array.isArray(cardIds) || cardIds.length === 0) return;

    // Retrieve cards from hand
    const cardsToPlay = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    if (cardsToPlay.length !== cardIds.length) return;

    // Check stacking / multi-play validity
    const firstVal = cardsToPlay[0].value;
    const allSameValue = cardsToPlay.every(c => c.value === firstVal);
    if (!allSameValue) return;

    const topCard = room.discardPile[room.discardPile.length - 1];
    const leadCard = cardsToPlay[0];

    // Check Domain Restriction
    if (room.domainColor && leadCard.color !== 'Wild' && leadCard.color !== room.domainColor) {
      return socket.emit('errorMsg', `🌀 Domain Lock Active! Must play ${room.domainColor} cards.`);
    }

    // Standard Move Validation
    let isValidMove = false;

    if (room.stackedDraw > 0) {
      // Must play stackable counter
      if (['+2', '+4', '+25'].includes(leadCard.value) || leadCard.value === 'Shield' || leadCard.value === 'Reflect') {
        isValidMove = true;
      }
    } else {
      if (
        leadCard.color === 'Wild' ||
        leadCard.color === topCard.color ||
        leadCard.value === topCard.value ||
        (topCard.chosenColor && leadCard.color === topCard.chosenColor)
      ) {
        isValidMove = true;
      }
    }

    if (!isValidMove) return;

    // Remove cards from player hand
    player.hand = player.hand.filter(c => !cardIds.includes(c.id));

    // Handle UNO check failure penalty
    if (player.hand.length === 1 && !player.calledUno) {
      drawCardsForPlayer(room, player, 2);
      socket.emit('handPenaltyMsg', '🚨 You forgot to call UNO! (+2 Cards Penalty)');
    } else if (player.hand.length !== 1) {
      player.calledUno = false;
    }

    // Process Cards Effects
    cardsToPlay.forEach(c => {
      c.offsetX = (Math.random() - 0.5) * 20;
      c.offsetY = (Math.random() - 0.5) * 20;
      c.rot = (Math.random() - 0.5) * 40;
      if (chosenColor) c.chosenColor = chosenColor;
      room.discardPile.push(c);
    });

    let skipTurns = 0;
    let triggerRed7 = false;

    cardsToPlay.forEach(card => {
      // Standard Effects
      if (card.value === '+2') room.stackedDraw += 2;
      if (card.value === '+4') room.stackedDraw += 4;
      if (card.value === 'Skip') skipTurns++;
      if (card.value === 'Reverse') room.direction *= -1;

      // Check Red 7 Rule
      if (room.red7Rule && card.color === 'Red' && card.value === '7') {
        triggerRed7 = true;
      }

      // Rare Custom Cards Effects
      if (card.value === 'Shield') {
        room.stackedDraw = 0; // Negates active draw stack
      }

      if (card.value === 'Roulette') {
        const target = room.players[getNextTurnIndex(room, 1)];
        const penalty = Math.floor(Math.random() * 5) + 1;
        drawCardsForPlayer(room, target, penalty);
        io.to(target.socketId).emit('handPenaltyMsg', `🎲 Roulette hit you! You drew ${penalty} cards.`);
      }

      if (card.value === 'Spy') {
        const target = room.players[getNextTurnIndex(room, 1)];
        if (target) {
          room.revealedPlayers.push({ sessionId: target.sessionId, cards: target.hand });
        }
      }

      if (card.value === 'TaxCollector') {
        room.players.forEach(p => {
          if (p.sessionId !== player.sessionId && p.hand.length > 0) {
            const stolen = p.hand.pop();
            player.hand.push(stolen);
          }
        });
      }

      // Mythic Custom Cards Effects
      if (card.value === '+25') room.stackedDraw += 25;

      if (card.value === 'Reset') {
        room.stackedDraw = 0;
        room.players.forEach(p => {
          p.hand = [];
          for (let i = 0; i < 7; i++) p.hand.push(room.deck.pop());
        });
      }

      if (card.value === 'Domain') {
        room.domainColor = chosenColor || 'Red';
        room.domainTurns = 4;
      }

      if (card.value === 'Reflect') {
        room.direction *= -1; // Reflects back to previous player
      }
    });

    io.to(room.code).emit('cardPlayedEvent', {
      isWildPlus4: leadCard.value === '+4',
      isHeavyStack: room.stackedDraw >= 8
    });

    // Check Win Condition
    if (player.hand.length === 0) {
      room.inGame = false;
      if (room.timer) clearInterval(room.timer);

      const leaderboard = [...room.players].sort((a, b) => a.hand.length - b.hand.length);
      io.to(room.code).emit('gameOver', leaderboard.map(p => ({
        sessionId: p.sessionId,
        name: p.name
      })));
      return;
    }

    if (triggerRed7) {
      triggerRed7Event(room);
    }

    advanceTurn(room, skipTurns);
    broadcastGameState(room);
  });

  // DRAW CARD
  socket.on('drawCard', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.inGame) return;

    const player = room.players[room.turnIndex];
    if (!player || player.socketId !== socket.id) return;

    const count = room.stackedDraw > 0 ? room.stackedDraw : 1;
    room.stackedDraw = 0;

    drawCardsForPlayer(room, player, count);
    advanceTurn(room);
    broadcastGameState(room);
  });

  // CALL UNO
  socket.on('callUno', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (player) {
      player.calledUno = true;
      socket.emit('unoAcknowledged');
      io.to(room.code).emit('unoCalledEvent', { sender: player.name });
    }
  });

  // EXTEND HAND (RED 7 RULE SLAP)
  socket.on('extendHand', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.red7Active) return;

    if (!room.red7Slapped.includes(userSessionId)) {
      room.red7Slapped.push(userSessionId);
      const player = room.players.find(p => p.sessionId === userSessionId);
      io.to(room.code).emit('handExtendedEvent', {
        avatar: player ? player.avatar : '✋',
        order: room.red7Slapped.length
      });
    }
  });

  // CHAT & EMOJIS
  socket.on('sendChat', (text) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const player = room.players.find(p => p.socketId === socket.id);
    const senderName = player ? player.name : 'Unknown';

    if (text === '/debug') {
      return socket.emit('openDebugMenu');
    }

    io.to(room.code).emit('chatMessage', { sender: senderName, text });
  });

  socket.on('sendEmoji', (emoji) => {
    const room = rooms.get(currentRoomCode);
    if (room) {
      io.to(room.code).emit('displayEmoji', { emoji });
    }
  });

  // DEBUG CARD SPAWNER
  socket.on('debugGiveCard', ({ color, value, rarity }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (player) {
      const newCard = {
        id: `debug_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        color,
        value,
        rarity: rarity || null
      };
      player.hand.push(newCard);
      socket.emit('yourHand', player.hand);
    }
  });

  // DISCONNECT HANDLER
  socket.on('disconnect', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (room.players.length === 0) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(currentRoomCode);
    } else {
      if (room.hostSessionId === userSessionId) {
        room.hostSessionId = room.players[0].sessionId;
      }
      if (room.inGame) {
        room.turnIndex = room.turnIndex % room.players.length;
        broadcastGameState(room);
      }
      broadcastLobbyUpdate(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎴 UNO Party Deluxe Server listening on http://localhost:${PORT}`);
});