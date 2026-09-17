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
      deck.push({ color: 'Wild', value: '+4', id: Math.random().toString(36).substr(2, 9) });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function startTurnTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timer) clearInterval(room.timer);
  room.timeLeft = 10;

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
  if (room.deck.length === 0) room.deck = createDeck();

  const drawn = room.deck.pop();
  currentPlayer.cards.push(drawn);

  io.to(currentPlayer.id).emit('yourHand', currentPlayer.cards);
  advanceTurn(room, 1);
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.finished);
}

function advanceTurn(room, steps = 1) {
  const total = room.players.length;
  for (let i = 0; i < steps; i++) {
    do {
      room.currentTurnIndex = (room.currentTurnIndex + room.direction + total) % total;
    } while (room.players[room.currentTurnIndex].finished);
  }

  const active = getActivePlayers(room);
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
    direction: room.direction
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

io.on('connection', (socket) => {

  socket.on('joinRoom', ({ username, roomCode }) => {
    if (!rooms[roomCode]) {
      rooms[roomCode] = { 
        players: [], gameStarted: false, deck: [], discardPile: [], 
        currentTurnIndex: 0, leaderboard: [], direction: 1, timer: null, timeLeft: 10, roomCode
      };
    }

    const room = rooms[roomCode];
    if (room.players.length >= 12) return socket.emit('errorMsg', 'Room is full! Max 12.');
    if (room.gameStarted) return socket.emit('errorMsg', 'Game already started.');

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
    room.discardPile = [];
    room.direction = 1;

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
    advanceTurn(room, 0);
  });

  socket.on('playCard', ({ cardId, chosenColor }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const player = room.players[room.currentTurnIndex];
    if (player.id !== socket.id || player.finished) return;

    const idx = player.cards.findIndex(c => c.id === cardId);
    if (idx === -1) return;

    const played = player.cards[idx];
    const top = room.discardPile[room.discardPile.length - 1];

    const isMatch = played.color === 'Wild' || 
                    played.color === top.color || 
                    played.value === top.value;

    if (!isMatch) return;

    if (played.color === 'Wild') played.color = chosenColor || 'Red';

    player.cards.splice(idx, 1);
    addCardToPile(room, played);

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
    if (played.value === 'Reverse') room.direction *= -1;
    if (played.value === 'Skip') skipSteps = 2;

    if (played.value === '+2' || played.value === '+4') {
      const drawCount = played.value === '+2' ? 2 : 4;
      const targetIdx = (room.currentTurnIndex + room.direction + room.players.length) % room.players.length;
      const targetPlayer = room.players[targetIdx];

      for (let i = 0; i < drawCount; i++) {
        if (room.deck.length === 0) room.deck = createDeck();
        targetPlayer.cards.push(room.deck.pop());
      }
      io.to(targetPlayer.id).emit('yourHand', targetPlayer.cards);
      skipSteps = 2;
    }

    socket.emit('yourHand', player.cards);
    advanceTurn(room, skipSteps);
  });

  socket.on('drawCard', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.gameStarted) return;

    const player = room.players[room.currentTurnIndex];
    if (player.id !== socket.id || player.finished) return;

    if (room.deck.length === 0) room.deck = createDeck();
    player.cards.push(room.deck.pop());

    socket.emit('yourHand', player.cards);
    advanceTurn(room, 1);
  });

  socket.on('disconnect', () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      const room = rooms[socket.roomCode];
      room.players = room.players.filter(p => p.id !== socket.id);
      io.to(socket.roomCode).emit('updateLobby', room.players);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));