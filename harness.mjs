/**
 * Local validation harness. Acts as the SCOREKEEPER and REFEREE against a dev
 * Cheesy Arena so a real match runs with real scoring, and the content desk
 * bridge can be observed end to end.
 *
 * The bridge itself never touches these control endpoints. This is a separate
 * client standing in for the volunteers who would normally drive them.
 *
 *   node harness.mjs
 */
import { WebSocket } from 'ws';

const ARENA = process.env.ARENA ?? 'localhost:8080';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = url => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});
const send = (ws, type, data) => ws.send(JSON.stringify({ type, data }));

const play = await open(`ws://${ARENA}/match_play/websocket`);
play.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'error') console.log('ARENA ERROR:', JSON.stringify(m.data));
});

// Scoring panels. The 2026 build uses plain "red"/"blue" positions, not the
// older near/far split.
const redScore = await open(`ws://${ARENA}/panels/scoring/red/websocket`);
const blueScore = await open(`ws://${ARENA}/panels/scoring/blue/websocket`);
console.log('harness connected');

for (const s of ['R1', 'R2', 'R3', 'B1', 'B2', 'B3']) {
  send(play, 'toggleBypass', s);
  await sleep(150);
}
await sleep(800);

send(play, 'startMatch', { MuteMatchSounds: true });
console.log('match started', new Date().toISOString());

// Auto: red climbs, which should give red the auto win.
await sleep(6000);
send(redScore, 'autoTower', { TeamPosition: 1, AutoTowerStatus: 1 });
console.log('auto: red 1 climbs');

// Teleop climbs so tower points move mid-match.
await sleep(30_000);
send(blueScore, 'endgame', { TeamPosition: 1, EndgameTowerStatus: 2 });
console.log('teleop: blue 1 climbs L2');

await sleep(40_000);
send(redScore, 'endgame', { TeamPosition: 2, EndgameTowerStatus: 3 });
console.log('teleop: red 2 climbs L3');

// Run out the match, then commit the results.
await sleep(100_000);
console.log('committing results');
send(play, 'commitAndPost', {});
await sleep(4000);
console.log('harness done');
process.exit(0);
