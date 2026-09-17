const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// Store active lobbies and their player lists
const rooms = {};

io.on('connection', (socket) => {
  
  // Handle a player trying to join a room
  socket.on('joinRoom', ({ username, roomCode }) => {
    // Check if room exists or create a new one
    if (!rooms[roomCode]) {
      rooms[roomCode] = { players: [], gameStarted: false };
    }

    const room = rooms[roomCode];

    // Whitelist check: Max 8 players per room
    if (room.players.length >= 8) {
      socket.emit('errorMsg', 'Room is full! Max 8 players.');
      return;
    }

    // Add player to the lobby
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username;
    
    room.players.push({ id: socket.id, name: username, cards: [] });

    // Send updated lobby list to everyone in this room
    io.to(roomCode).emit('updateLobby', room.players);
  });

  // Handle playing a card
  socket.on('playCard', (cardData) => {
    // Broadcast the played card to everyone in the same room
    io.to(socket.roomCode).emit('cardPlayed', { 
      player: socket.username, 
      card: cardData 
    });
  });

  // Handle player disconnects
  socket.on('disconnect', () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      rooms[socket.roomCode].players = rooms[socket.roomCode].players.filter(p => p.id !== socket.id);
      io.to(socket.roomCode).emit('updateLobby', rooms[socket.roomCode].players);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const path = require('path');

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to explicitly serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});