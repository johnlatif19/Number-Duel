require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');

// Initialize Firebase Admin (optional)
let firebaseAdmin = null;
try {
  if (process.env.FIREBASE_CONFIG) {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    firebaseAdmin = require('firebase-admin');
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(firebaseConfig)
    });
    console.log('Firebase initialized successfully');
  }
} catch (error) {
  console.log('Firebase not configured or error:', error.message);
}

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage
const rooms = new Map();
const players = new Map();
const gameSessions = new Map();
const roomCodes = new Set();

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
}

// Generate unique room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  let attempts = 0;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    attempts++;
  } while (roomCodes.has(code) && attempts < 100);
  return code;
}

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Login route
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  if (username === process.env.ADMIN_USERNAME && 
      password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign(
      { username, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ 
      token, 
      username,
      message: 'Login successful'
    });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Verify token
app.get('/api/verify', authenticateToken, (req, res) => {
  res.json({ 
    valid: true, 
    user: req.user 
  });
});

// Dashboard stats
app.get('/api/dashboard/stats', authenticateToken, (req, res) => {
  const roomStats = Array.from(rooms.values()).map(room => ({
    code: room.code,
    players: room.players ? room.players.length : 0,
    playerNames: room.players ? room.players.map(p => p.name) : [],
    status: room.status || 'waiting',
    createdAt: room.createdAt,
    currentTurn: room.currentTurn
  }));
  
  res.json({
    totalRooms: rooms.size,
    totalPlayers: players.size,
    activeGames: gameSessions.size,
    rooms: roomStats
  });
});

// Get room info
app.get('/api/room/:code', (req, res) => {
  const { code } = req.params;
  const room = rooms.get(code);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({
    code: room.code,
    players: room.players ? room.players.length : 0,
    status: room.status,
    playerNames: room.players ? room.players.map(p => p.name) : []
  });
});

// Create room API (for admin)
app.post('/api/room/create', authenticateToken, (req, res) => {
  const roomCode = generateRoomCode();
  
  const room = {
    code: roomCode,
    players: [],
    status: 'waiting',
    currentTurn: null,
    winner: null,
    createdAt: new Date().toISOString()
  };
  
  rooms.set(roomCode, room);
  roomCodes.add(roomCode);
  
  res.json({
    roomCode,
    message: 'Room created successfully'
  });
});

// Socket.IO logic
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Create room from client
  socket.on('create-room', (data) => {
    const { playerName, secretNumber } = data;
    
    if (!playerName || playerName.trim() === '') {
      socket.emit('error', { message: 'Player name is required' });
      return;
    }
    
    if (secretNumber === undefined || secretNumber === null) {
      socket.emit('error', { message: 'Secret number is required' });
      return;
    }
    
    const roomCode = generateRoomCode();
    
    const room = {
      code: roomCode,
      players: [],
      status: 'waiting',
      currentTurn: null,
      winner: null,
      createdAt: new Date().toISOString()
    };
    
    rooms.set(roomCode, room);
    roomCodes.add(roomCode);
    
    // Add player to room
    const player = {
      id: socket.id,
      name: playerName.trim(),
      secretNumber: parseInt(secretNumber),
      isReady: true
    };
    
    room.players.push(player);
    players.set(socket.id, player);
    socket.join(roomCode);
    
    socket.emit('room-created', { 
      roomCode,
      player: { id: socket.id, name: playerName }
    });
    
    console.log(`Room ${roomCode} created by ${playerName}`);
  });
  
  // Join room
  socket.on('join-room', (data) => {
    const { roomCode, playerName, secretNumber } = data;
    
    if (!roomCode || !roomCodes.has(roomCode)) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    const room = rooms.get(roomCode);
    
    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }
    
    if (!playerName || playerName.trim() === '') {
      socket.emit('error', { message: 'Player name is required' });
      return;
    }
    
    if (secretNumber === undefined || secretNumber === null) {
      socket.emit('error', { message: 'Secret number is required' });
      return;
    }
    
    const player = {
      id: socket.id,
      name: playerName.trim(),
      secretNumber: parseInt(secretNumber),
      isReady: true
    };
    
    room.players.push(player);
    players.set(socket.id, player);
    socket.join(roomCode);
    
    socket.emit('joined-room', {
      roomCode,
      player: { id: socket.id, name: playerName }
    });
    
    // If room has 2 players, start game
    if (room.players.length === 2) {
      room.status = 'playing';
      room.currentTurn = room.players[0].id;
      
      const gameData = {
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          secretNumber: p.secretNumber
        })),
        currentTurn: room.currentTurn,
        startTime: new Date().toISOString()
      };
      
      gameSessions.set(roomCode, gameData);
      
      io.to(roomCode).emit('game-start', {
        players: room.players.map(p => ({ 
          id: p.id, 
          name: p.name 
        })),
        currentTurn: room.currentTurn
      });
      
      // Send turn info to both players
      room.players.forEach(p => {
        const opponent = room.players.find(op => op.id !== p.id);
        io.to(p.id).emit('your-turn', {
          isYourTurn: p.id === room.currentTurn,
          opponentName: opponent ? opponent.name : 'Waiting for opponent'
        });
      });
      
      console.log(`Game started in room ${roomCode}`);
    }
    
    // Notify all players in room about update
    io.to(roomCode).emit('players-update', {
      players: room.players.map(p => ({ 
        id: p.id, 
        name: p.name 
      })),
      count: room.players.length
    });
  });
  
  // Player makes a guess
  socket.on('make-guess', (data) => {
    const { roomCode, guess } = data;
    const room = rooms.get(roomCode);
    
    if (!room || room.status !== 'playing') {
      socket.emit('error', { message: 'Game not active' });
      return;
    }
    
    if (room.currentTurn !== socket.id) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }
    
    const game = gameSessions.get(roomCode);
    if (!game) {
      socket.emit('error', { message: 'Game session not found' });
      return;
    }
    
    const opponent = game.players.find(p => p.id !== socket.id);
    if (!opponent) {
      socket.emit('error', { message: 'Opponent not found' });
      return;
    }
    
    const guessNum = parseInt(guess);
    if (isNaN(guessNum)) {
      socket.emit('error', { message: 'Invalid guess' });
      return;
    }
    
    const secretNum = opponent.secretNumber;
    
    let result;
    let isCorrect = false;
    let difference = Math.abs(guessNum - secretNum);
    
    if (guessNum === secretNum) {
      result = 'correct';
      isCorrect = true;
    } else if (guessNum < secretNum) {
      result = 'higher';
    } else {
      result = 'lower';
    }
    
    // Send feedback to guesser
    socket.emit('guess-result', {
      result,
      guess: guessNum,
      isCorrect,
      difference: isCorrect ? 0 : difference,
      attempts: game.attempts ? game.attempts + 1 : 1
    });
    
    // Send feedback to opponent
    const opponentSocket = io.sockets.sockets.get(opponent.id);
    if (opponentSocket) {
      opponentSocket.emit('opponent-guessed', {
        result,
        guess: guessNum,
        difference
      });
    }
    
    if (isCorrect) {
      // Game over - player won
      room.status = 'finished';
      room.winner = socket.id;
      
      io.to(roomCode).emit('game-over', {
        winner: socket.id,
        winnerName: room.players.find(p => p.id === socket.id)?.name,
        secretNumber: secretNum,
        attempts: game.attempts || 1
      });
      
      gameSessions.delete(roomCode);
      console.log(`Game over in room ${roomCode} - Winner: ${room.players.find(p => p.id === socket.id)?.name}`);
    } else {
      // Update attempts
      if (!game.attempts) game.attempts = 0;
      game.attempts++;
      
      // Switch turn
      room.currentTurn = opponent.id;
      game.currentTurn = opponent.id;
      
      io.to(roomCode).emit('turn-switch', {
        currentTurn: opponent.id,
        playerId: opponent.id,
        playerName: opponent.name
      });
      
      room.players.forEach(p => {
        const opp = room.players.find(op => op.id !== p.id);
        io.to(p.id).emit('your-turn', {
          isYourTurn: p.id === opponent.id,
          opponentName: opp ? opp.name : 'Opponent'
        });
      });
    }
  });
  
  // Chat message
  socket.on('chat-message', (data) => {
    const { roomCode, message } = data;
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    const player = players.get(socket.id);
    if (!player) return;
    
    io.to(roomCode).emit('chat-message', {
      playerName: player.name,
      message: message.trim(),
      timestamp: new Date().toISOString(),
      playerId: socket.id
    });
  });
  
  // Typing indicator
  socket.on('typing', (data) => {
    const { roomCode, isTyping } = data;
    const room = rooms.get(roomCode);
    if (!room) return;
    
    const player = players.get(socket.id);
    if (!player) return;
    
    socket.to(roomCode).emit('typing-indicator', {
      playerName: player.name,
      isTyping
    });
  });
  
  // Restart game
  socket.on('restart-game', (data) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    // Reset game state
    room.status = 'playing';
    room.currentTurn = room.players[0].id;
    room.winner = null;
    
    // Create new game session with same players
    const newGame = {
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        secretNumber: p.secretNumber
      })),
      currentTurn: room.players[0].id,
      startTime: new Date().toISOString(),
      attempts: 0
    };
    
    gameSessions.set(roomCode, newGame);
    
    io.to(roomCode).emit('game-restarted', {
      players: room.players.map(p => ({ 
        id: p.id, 
        name: p.name 
      })),
      currentTurn: room.currentTurn
    });
    
    room.players.forEach(p => {
      const opponent = room.players.find(op => op.id !== p.id);
      io.to(p.id).emit('your-turn', {
        isYourTurn: p.id === room.currentTurn,
        opponentName: opponent ? opponent.name : 'Opponent'
      });
    });
    
    console.log(`Game restarted in room ${roomCode}`);
  });
  
  // Leave room
  socket.on('leave-room', (data) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);
    
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      room.players = room.players.filter(p => p.id !== socket.id);
      players.delete(socket.id);
      
      if (room.players.length === 0) {
        rooms.delete(roomCode);
        roomCodes.delete(roomCode);
        gameSessions.delete(roomCode);
        console.log(`Room ${roomCode} deleted (empty)`);
      } else {
        if (room.status === 'playing') {
          room.status = 'waiting';
          gameSessions.delete(roomCode);
        }
        
        io.to(roomCode).emit('player-left', {
          playerId: socket.id,
          playerName: player ? player.name : 'Unknown',
          players: room.players.map(p => ({ 
            id: p.id, 
            name: p.name 
          }))
        });
        
        console.log(`Player left room ${roomCode}`);
      }
      
      socket.leave(roomCode);
    }
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Clean up player from rooms
    const player = players.get(socket.id);
    if (player) {
      for (const [roomCode, room] of rooms) {
        if (room.players.some(p => p.id === socket.id)) {
          room.players = room.players.filter(p => p.id !== socket.id);
          
          if (room.players.length === 0) {
            rooms.delete(roomCode);
            roomCodes.delete(roomCode);
            gameSessions.delete(roomCode);
            console.log(`Room ${roomCode} deleted (disconnect)`);
          } else {
            if (room.status === 'playing') {
              room.status = 'waiting';
              gameSessions.delete(roomCode);
            }
            
            io.to(roomCode).emit('player-left', {
              playerId: socket.id,
              playerName: player.name,
              players: room.players.map(p => ({ 
                id: p.id, 
                name: p.name 
              }))
            });
          }
        }
      }
      players.delete(socket.id);
    }
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Number Duel Server running on port ${PORT}`);
  console.log(`📱 Visit http://localhost:${PORT} to play!`);
  console.log(`🔐 Admin login at http://localhost:${PORT}/login`);
  console.log(`📊 Dashboard at http://localhost:${PORT}/dashboard`);
  console.log(`🏠 Create room at http://localhost:${PORT}/create-room`);
  console.log(`🚪 Enter room at http://localhost:${PORT}/enter-room`);
  console.log(`👥 Active rooms: ${rooms.size}`);
});
