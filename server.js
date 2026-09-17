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

// Helper: Build a standard 4-color numbered deck
function createDeck() {
  const colors = ['Red', 'Blue', 'Green', 'Yellow'];
  const deck = [];
  for (let color of colors) {
    for (let num = 0; num <= 9; num++) {
      deck.push({ color, value: num, id: Math.random().toString(36).substr(2, 9) });
    }
  }
  // Shuffle deck
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
        currentTurnIndex: 0 
      };
    }

    const room = rooms[roomCode];

    if (room.players.length >= 8) {
      socket.emit('errorMsg', 'Room is full! Max 8 players.');
      return;
    }
    if (room.gameStarted) {
      socket.emit('errorMsg', 'Game already in progress.');
      return;
    }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username;
    
    room.players.push({ id: socket.id, name: username, cards: [] });
    io.to(roomCode).emit('updateLobby', room.players);
  });

  // Start the Game: Deal cards and set top card
  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.players.length < 2) return;

    room.gameStarted = true;
    room.deck = createDeck();

    // Deal 7 cards to each player
    room.players.forEach(player => {
      player.cards = room.deck.splice(0, 7);
      io.to(player.id).emit('yourHand', player.cards);
    });

    // Set initial discard pile card
    room.topCard = room.deck.pop();
    room.currentTurnIndex = 0;

    io.to(socket.roomCode).emit('gameState', {
      topCard: room.topCard,
      currentTurn: room.players[room.currentTurnIndex].name
    });
  });

  // Play a card logic
  socket.on('playCard', (cardId) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer.id !== socket.id) return; // Not your turn!

    const cardIndex = currentPlayer.cards.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const playedCard = currentPlayer.cards[cardIndex];

    // UNO Rule: Must match color OR value
    if (playedCard.color === room.topCard.color || playedCard.value === room.topCard.value) {
      currentPlayer.cards.splice(cardIndex, 1);
      room.topCard = playedCard;

      // Check for win condition
      if (currentPlayer.cards.length === 0) {
        io.to(socket.roomCode).emit('gameOver', currentPlayer.name);
        return;
      }

      // Move turn to next player
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;

      // Send updated hand back to player who played
      socket.emit('yourHand', currentPlayer.cards);

      // Broadcast new state to everyone in room
      io.to(socket.roomCode).emit('gameState', {
        topCard: room.topCard,
        currentTurn: room.players[room.currentTurnIndex].name
      });
    }
  });

  // Draw card logic
  socket.on('drawCard', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer.id !== socket.id) return;

    if (room.deck.length === 0) room.deck = createDeck();

    const drawnCard = room.deck.pop();
    currentPlayer.cards.push(drawnCard);

    // Pass turn to next player
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;

    socket.emit('yourHand', currentPlayer.cards);
    io.to(socket.roomCode).emit('gameState', {
      topCard: room.topCard,
      currentTurn: room.players[room.currentTurnIndex].name
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