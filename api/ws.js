import express from 'express';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();
const MAX_PARTICIPANTS = 12;

function safeSend(socket, payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload, exceptId) {
  for (const [clientId, socket] of room.participants) {
    if (clientId !== exceptId) safeSend(socket, payload);
  }
}

function roomSnapshot(room) {
  return {
    participantCount: room.participants.size,
    activeSharer: room.activeSharer ?? null,
  };
}

function cleanup(socket) {
  const { roomId, clientId } = socket;
  if (!roomId || !clientId) return;

  const room = rooms.get(roomId);
  if (!room || room.participants.get(clientId) !== socket) return;

  room.participants.delete(clientId);
  const stoppedSharing = room.activeSharer === clientId;
  if (stoppedSharing) room.activeSharer = null;

  broadcast(room, {
    type: 'participant-left',
    clientId,
    ...roomSnapshot(room),
  });

  if (stoppedSharing) {
    broadcast(room, {
      type: 'sharing-state',
      activeSharer: null,
      participantCount: room.participants.size,
    });
  }

  if (room.participants.size === 0) rooms.delete(roomId);
}

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      safeSend(socket, { type: 'error', message: 'Invalid message.' });
      return;
    }

    if (message.type === 'join') {
      const roomId = typeof message.roomId === 'string' ? message.roomId.trim() : '';
      if (!/^[a-zA-Z0-9_-]{20,80}$/.test(roomId)) {
        safeSend(socket, { type: 'error', message: 'Invalid room.' });
        socket.close(4000, 'Invalid room');
        return;
      }

      const room = rooms.get(roomId) ?? { participants: new Map(), activeSharer: null };
      if (room.participants.size >= MAX_PARTICIPANTS) {
        safeSend(socket, { type: 'error', message: `This room is full (${MAX_PARTICIPANTS} people max).` });
        socket.close(4003, 'Room full');
        return;
      }

      const clientId = randomUUID();
      const existingPeers = [...room.participants.keys()];
      room.participants.set(clientId, socket);
      socket.roomId = roomId;
      socket.clientId = clientId;
      rooms.set(roomId, room);

      safeSend(socket, {
        type: 'joined',
        clientId,
        peers: existingPeers,
        ...roomSnapshot(room),
      });

      broadcast(room, {
        type: 'participant-joined',
        clientId,
        ...roomSnapshot(room),
      }, clientId);
      return;
    }

    if (!socket.roomId || !socket.clientId) {
      safeSend(socket, { type: 'error', message: 'Join a room first.' });
      return;
    }

    const room = rooms.get(socket.roomId);
    if (!room) return;

    if (message.type === 'signal') {
      const targetId = typeof message.target === 'string' ? message.target : '';
      const target = room.participants.get(targetId);
      if (target) {
        safeSend(target, {
          type: 'signal',
          from: socket.clientId,
          data: message.data,
        });
      }
      return;
    }

    if (message.type === 'start-sharing') {
      if (room.activeSharer && room.activeSharer !== socket.clientId) {
        safeSend(socket, {
          type: 'share-denied',
          activeSharer: room.activeSharer,
          message: 'Someone is already sharing their screen.',
        });
        return;
      }

      room.activeSharer = socket.clientId;
      broadcast(room, {
        type: 'sharing-state',
        activeSharer: socket.clientId,
        participantCount: room.participants.size,
      });
      return;
    }

    if (message.type === 'stop-sharing' && room.activeSharer === socket.clientId) {
      room.activeSharer = null;
      broadcast(room, {
        type: 'sharing-state',
        activeSharer: null,
        participantCount: room.participants.size,
      });
    }
  });

  socket.on('close', () => cleanup(socket));
  socket.on('error', () => cleanup(socket));
});

app.get('/api/ws', (_req, res) => {
  res.status(426).send('Upgrade Required');
});

export default server;
