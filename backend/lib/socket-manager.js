/**
 * Socket.IO Manager — Real-time processing updates
 */
const { Server } = require('socket.io');

let io;
const assessmentRooms = new Map();

function init(httpServer, corsOrigins) {
  io = new Server(httpServer, {
    cors: {
      origin: corsOrigins || '*',
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on('join_assessment', (assessmentId) => {
      socket.join(`assessment_${assessmentId}`);
      if (!assessmentRooms.has(assessmentId)) {
        assessmentRooms.set(assessmentId, new Set());
      }
      assessmentRooms.get(assessmentId).add(socket.id);
    });

    socket.on('leave_assessment', (assessmentId) => {
      socket.leave(`assessment_${assessmentId}`);
      const room = assessmentRooms.get(assessmentId);
      if (room) {
        room.delete(socket.id);
        if (room.size === 0) assessmentRooms.delete(assessmentId);
      }
    });

    socket.on('disconnect', () => {
      for (const [assessmentId, sockets] of assessmentRooms.entries()) {
        sockets.delete(socket.id);
        if (sockets.size === 0) assessmentRooms.delete(assessmentId);
      }
    });
  });

  return io;
}

function emitToAssessment(assessmentId, event, data) {
  if (io) {
    io.to(`assessment_${assessmentId}`).emit(event, { ...data, timestamp: new Date().toISOString() });
  }
}

function emitGlobal(event, data) {
  if (io) {
    io.emit(event, data);
  }
}

module.exports = { init, emitToAssessment, emitGlobal };
