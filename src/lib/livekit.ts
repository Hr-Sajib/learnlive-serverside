import {
  AccessToken,
  RoomServiceClient,
  WebhookReceiver,
  type ParticipantInfo,
  type WebhookEvent,
} from 'livekit-server-sdk';
import { config } from '@/config';
import { AppError } from '@/utils/AppError';
import { StatusCodes } from 'http-status-codes';

function requireLiveKit(): { key: string; secret: string; host: string; wsUrl: string } {
  if (!config.livekit.isConfigured) {
    throw new AppError(
      StatusCodes.SERVICE_UNAVAILABLE,
      'Live classes are not configured on this server yet.',
      'LIVEKIT_NOT_CONFIGURED',
    );
  }
  return {
    key: config.livekit.apiKey!,
    secret: config.livekit.apiSecret!,
    host: config.livekit.host!,
    wsUrl: config.livekit.wsUrl!,
  };
}

let roomClient: RoomServiceClient | null = null;

export function getRoomService(): RoomServiceClient {
  const { key, secret, host } = requireLiveKit();
  roomClient ??= new RoomServiceClient(host, key, secret);
  return roomClient;
}

let webhookReceiver: WebhookReceiver | null = null;

export function getWebhookReceiver(): WebhookReceiver {
  const { key, secret } = requireLiveKit();
  webhookReceiver ??= new WebhookReceiver(key, secret);
  return webhookReceiver;
}

/**
 * Verifies a LiveKit webhook against the raw request body. The signature is
 * computed over the exact bytes LiveKit sent, so the webhook route must be
 * mounted with `express.raw()` and never with the JSON body parser.
 */
export async function parseWebhook(rawBody: Buffer, authHeader: string): Promise<WebhookEvent> {
  return getWebhookReceiver().receive(rawBody.toString('utf8'), authHeader);
}

export interface JoinTokenOptions {
  roomName: string;
  /**
   * Must be the Mongo user id. Presence webhooks arrive carrying only this
   * identity, so it is the join key back to our AttendanceRecord rows.
   * LiveKit also enforces identity uniqueness per room, which is what stops a
   * student from doubling their presence time by joining on two devices.
   */
  identity: string;
  displayName: string;
  /** Admins publish and moderate; students publish their own tracks only. */
  isHost: boolean;
  /** Token lifetime. Long enough to outlive a class, short enough to not be a standing pass. */
  ttlSeconds?: number;
}

export async function mintJoinToken(opts: JoinTokenOptions): Promise<{ token: string; wsUrl: string }> {
  const { key, secret, wsUrl } = requireLiveKit();

  const at = new AccessToken(key, secret, {
    identity: opts.identity,
    name: opts.displayName,
    ttl: opts.ttlSeconds ?? 4 * 60 * 60,
  });

  at.addGrant({
    room: opts.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    // Only the host may mute others or remove a participant.
    roomAdmin: opts.isHost,
  });

  return { token: await at.toJwt(), wsUrl };
}

/** Live participant identities in a room. Empty array if the room does not exist. */
export async function listRoomParticipants(roomName: string): Promise<ParticipantInfo[]> {
  try {
    return await getRoomService().listParticipants(roomName);
  } catch {
    // LiveKit 404s a room with nobody in it; that is "nobody present", not an error.
    return [];
  }
}

/** Ends the LiveKit room, disconnecting everyone still inside. */
export async function closeRoom(roomName: string): Promise<void> {
  try {
    await getRoomService().deleteRoom(roomName);
  } catch {
    // Already gone. Ending a class must not fail because the room expired first.
  }
}

export async function removeParticipant(roomName: string, identity: string): Promise<void> {
  try {
    await getRoomService().removeParticipant(roomName, identity);
  } catch {
    // Participant already left.
  }
}
