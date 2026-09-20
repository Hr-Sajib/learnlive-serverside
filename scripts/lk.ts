/* eslint-disable no-console */
import { config } from '../src/config';
import { getRoomService, listRoomParticipants } from '../src/lib/livekit';

/**
 * A small operator console for the LiveKit project.
 *
 *   npx tsx scripts/lk.ts status            credentials + connectivity check
 *   npx tsx scripts/lk.ts rooms             every open room and who is in it
 *   npx tsx scripts/lk.ts room <name>       one room in detail
 *   npx tsx scripts/lk.ts end <name> --yes  close a room, disconnecting everyone
 *
 * Read-only unless you pass --yes. Nothing here prints the API secret.
 */

const [, , command = 'status', arg] = process.argv;
const confirmed = process.argv.includes('--yes');

/** Never print a secret. A fingerprint is enough to tell two keys apart. */
const fingerprint = (value: string | undefined): string =>
  value ? `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)` : 'NOT SET';

async function status(): Promise<void> {
  console.log('LiveKit configuration');
  console.log('  API key      ', config.livekit.apiKey ?? 'NOT SET');
  console.log('  API secret   ', fingerprint(config.livekit.apiSecret));
  console.log('  REST host    ', config.livekit.host ?? 'NOT SET');
  console.log('  Browser URL  ', config.livekit.wsUrl ?? 'NOT SET');
  console.log('  Complete     ', config.livekit.isConfigured ? 'yes' : 'NO — live classes disabled');

  const host = config.livekit.host ?? '';
  const ws = config.livekit.wsUrl ?? '';
  if (host && ws && host.replace(/^https?:\/\//, '') !== ws.replace(/^wss?:\/\//, '')) {
    console.log('\n  WARNING: REST host and browser URL are different hostnames.');
    console.log('  They should be the same host, differing only in scheme (https:// vs wss://).');
  }

  if (!config.livekit.isConfigured) return;

  console.log('\nConnectivity');
  try {
    const rooms = await getRoomService().listRooms();
    console.log(`  Authenticated. ${rooms.length} open room(s).`);
  } catch (err) {
    console.log('  FAILED:', err instanceof Error ? err.message : err);
    console.log('  A 401 here means the key/secret pair is wrong.');
    console.log('  A DNS or timeout error means LIVEKIT_HOST is wrong.');
    process.exitCode = 1;
  }
}

async function rooms(): Promise<void> {
  const list = await getRoomService().listRooms();

  if (list.length === 0) {
    console.log('No open rooms. LiveKit creates one when the first participant joins.');
    return;
  }

  for (const room of list) {
    const participants = await listRoomParticipants(room.name);
    const age = room.creationTime
      ? `${Math.round((Date.now() / 1000 - Number(room.creationTime)) / 60)}m old`
      : 'unknown age';
    console.log(`\n${room.name}  (${participants.length} in room, ${age})`);

    for (const p of participants) {
      const joined = p.joinedAt ? new Date(Number(p.joinedAt) * 1000).toLocaleTimeString() : '?';
      console.log(`  ${p.identity.padEnd(26)} ${(p.name || '').padEnd(20)} joined ${joined}`);
    }
  }
}

async function room(name: string): Promise<void> {
  const participants = await listRoomParticipants(name);
  console.log(`${name}: ${participants.length} participant(s)`);
  console.log(JSON.stringify(participants, null, 2));
}

async function end(name: string): Promise<void> {
  if (!confirmed) {
    const participants = await listRoomParticipants(name);
    console.log(`Would close "${name}", disconnecting ${participants.length} participant(s).`);
    console.log('Re-run with --yes to actually do it.');
    return;
  }
  await getRoomService().deleteRoom(name);
  console.log(`Closed ${name}.`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'status':
      return status();
    case 'rooms':
      return rooms();
    case 'room':
      if (!arg) throw new Error('Usage: lk.ts room <name>');
      return room(arg);
    case 'end':
      if (!arg) throw new Error('Usage: lk.ts end <name> --yes');
      return end(arg);
    default:
      console.log('Commands: status | rooms | room <name> | end <name> --yes');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
