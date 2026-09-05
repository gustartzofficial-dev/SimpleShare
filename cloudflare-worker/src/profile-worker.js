import baseWorker, { RoomHub as CoreRoomHub, BudgetTracker } from './index.js';

export { BudgetTracker };

const MAX_AVATAR_LENGTH = 55000;
const AVATAR_RE = /^data:image\/(?:webp|png|jpeg);base64,/i;

function safeAvatar(value) {
  const avatar = typeof value === 'string' ? value : '';
  if (!avatar) return '';
  if (avatar.length > MAX_AVATAR_LENGTH || !AVATAR_RE.test(avatar)) return '';
  return avatar;
}

function decodeMessage(raw) {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

function publicParticipant(participant) {
  return {
    id: participant.id,
    name: participant.name,
    joinedAt: participant.joinedAt,
    mode: participant.mode,
    avatar: participant.avatar || '',
  };
}

/*
 * Add room-scoped profile pictures without touching the media transport.
 * The existing RoomHub still owns join/auth/signaling/stream state; this class
 * only persists one small avatar string on the participant record and announces
 * profile changes over the socket that already exists.
 */
export class RoomHub extends CoreRoomHub {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/join') {
      let requestedAvatar = '';
      try {
        const body = await request.clone().json();
        requestedAvatar = safeAvatar(body.avatar);
      } catch {}

      const response = await super.fetch(request);
      if (!response.ok || !requestedAvatar) return response;

      try {
        const joined = await response.clone().json();
        const state = await this.getState();
        const participant = state.participants[joined.participantId];
        if (participant && participant.token === joined.token && participant.avatar !== requestedAvatar) {
          participant.avatar = requestedAvatar;
          const rev = await this.putState(state);
          this.broadcast({ type: 'participant-updated', rev, participant: publicParticipant(participant) });
        }
      } catch {}
      return response;
    }

    return super.fetch(request);
  }

  async webSocketMessage(ws, raw) {
    const msg = decodeMessage(raw);
    if (!msg) return super.webSocketMessage(ws, raw);

    const attachment = ws.deserializeAttachment() || {};
    const participantId = attachment.participantId;

    if (msg.type === 'profile-update' && participantId) {
      const state = await this.getState();
      const participant = state.participants[participantId];
      if (!participant) return;

      const avatar = safeAvatar(msg.avatar);
      if (avatar) participant.avatar = avatar;
      else delete participant.avatar;

      const rev = await this.putState(state);
      this.broadcast({ type: 'participant-updated', rev, participant: publicParticipant(participant) });
      return;
    }

    // Keep the original rename behavior, then immediately publish the same
    // participant with its avatar attached so clients can remap the picture to
    // the new display name without waiting for a snapshot.
    if (msg.type === 'rename' && participantId) {
      await super.webSocketMessage(ws, raw);
      const state = await this.getState();
      const participant = state.participants[participantId];
      if (participant?.avatar) {
        this.broadcast({ type: 'participant-updated', rev: state.rev || 0, participant: publicParticipant(participant) });
      }
      return;
    }

    return super.webSocketMessage(ws, raw);
  }
}

export default baseWorker;
