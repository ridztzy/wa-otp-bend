const { Server } = require('socket.io');

function setupSocket(server, frontendUrl) {
  const io = new Server(server, {
    cors: {
      origin: frontendUrl,
      methods: ["GET", "POST"]
    }
  });

  io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    socket.on('disconnect', () => {
      console.log('🔌 Client disconnected:', socket.id);
    });
  });

  return io;
}

module.exports = { setupSocket };