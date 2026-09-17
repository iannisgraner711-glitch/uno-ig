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
  const deck = [];
  // Build extra cards so 12 players don't run out easily
  for (let i = 0; i < 2; i++) {
    for (let color of colors) {
      for (let num = 0; num <= 9; num++) {
        deck.push({ color, value: num, id: Math.random().toString(36).substr(2, 9) });
      }
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
  
  socket.on('joinRoom', ({ username, roomCode }) => {
    if (!rooms[roomCode]) {
      rooms[roomCode] = { 
        players: [], 
        gameStarted: false, 
        deck: [], 
        topCard: null, 
        currentTurnIndex: 0,
        leaderboard: []
      };
    }

    const room = rooms[roomCode];

    // Increased max players to 12
    if (room.players.length >= 12) {
      socket.emit('errorMsg', 'Room is full! Max 12 players.');
      return;
    }
    if (room.gameStarted) {
      socket.emit('errorMsg', 'Game already in progress.');
      return;
    }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username;
    
    room.players.push({ id: socket.id, name: username, cards: [], finished: false });
    io.to(roomCode).emit('updateLobby', room.players);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.players.length < 2) return;

    room.gameStarted = true;
    room.deck = createDeck();
    room.leaderboard = [];

    room.players.forEach(player => {
      player.cards = room.deck.splice(0, 7);
      player.finished = false;
      io.to(player.id).emit('yourHand', player.cards);
    });

    room.topCard = room.deck.pop();
    room.currentTurnIndex = 0;

    io.to(socket.roomCode).emit('gameState', {
      topCard: room.topCard,
      currentTurn: room.players[room.currentTurnIndex].name,
      leaderboard: room.leaderboard
    });
  });

  socket.on('playCard', (cardId) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer.id !== socket.id || currentPlayer.finished) return;

    const cardIndex = currentPlayer.cards.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const playedCard = currentPlayer.cards[cardIndex];

    if (playedCard.color === room.topCard.color || playedCard.value === room.topCard.value) {
      currentPlayer.cards.splice(cardIndex, 1);
      room.topCard = playedCard;

      // Check if player emptied their hand
      if (currentPlayer.cards.length === 0) {
        currentPlayer.finished = true;
        room.leaderboard.push(currentPlayer.name);
      }

      // Check remaining active players
      const activePlayers = room.players.filter(p => !p.finished);

      if (activePlayers.length <= 1) {
        if (activePlayers.length === 1) room.leaderboard.push(activePlayers[0].name);
        io.to(socket.roomCode).emit('gameOver', room.leaderboard);
        return;
      }

      // Advance turn to next active player
      do {
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      } while (room.players[room.currentTurnIndex].finished);

      socket.emit('yourHand', currentPlayer.cards);

      io.to(socket.roomCode).emit('gameState', {
        topCard: room.topCard,
        currentTurn: room.players[room.currentTurnIndex].name,
        leaderboard: room.leaderboard
      });
    }
  });

  socket.on('drawCard', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer.id !== socket.id || currentPlayer.finished) return;

    if (room.deck.length === 0) room.deck = createDeck();

    const drawnCard = room.deck.pop();
    currentPlayer.cards.push(drawnCard);

    do {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    } while (room.players[room.currentTurnIndex].finished);

    socket.emit('yourHand', currentPlayer.cards);
    io.to(socket.roomCode).emit('gameState', {
      topCard: room.topCard,
      currentTurn: room.players[room.currentTurnIndex].name,
      leaderboard: room.leaderboard
    });
  });

  socket.on('disconnect', () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      rooms[socket.roomCode].players = rooms[socket.roomCode].players.filter(p => p.id !== socket.id);
      io.to(socket.roomCode).emit('updateLobby', rooms[socket.roomCode].players);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));