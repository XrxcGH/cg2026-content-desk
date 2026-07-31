/**
 * Offline validation harness: the whole Cheesy integration, no field needed.
 *
 * Boots the fake arena (apps/core/src/ingest/cheesy/fake-arena.ts) and a real
 * core pointed at it with --cheesy, then watches /api/state for the checkpoint
 * sequence a real match produces. Nothing on the desk side is stubbed: the
 * hardened client, the allowlists, the adapter, the reducer, and the WS fan-out
 * all run exactly as they would at the venue.
 *
 *   node harness-offline.mjs [--speed 4]
 *
 * Prints a PASS/FAIL table and exits non-zero on the first failure. Use
 * harness.mjs instead when a real `cheesy-arena -dev` build is available.
 */

import { spawn } from 'node:child_process';

const argOf = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const SPEED = Number(argOf('speed') ?? 4);
const ARENA_PORT = 8091;
const CORE_PORT = 8721;
const BASE = `http://127.0.0.1:${CORE_PORT}`;

const procs = [];
const boot = (label, args) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => process.stdout.write(`  [${label}] ${d}`.replace(/\n(.)/g, '\n  [' + label + '] $1')));
  p.stderr.on('data', d => process.stderr.write(`  [${label}!] ${d}`));
  procs.push(p);
  return p;
};

const shutdown = code => {
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  process.exit(code);
};
process.on('SIGINT', () => shutdown(130));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = async () => (await fetch(`${BASE}/api/state`)).json();

/** Poll until `check(state)` is truthy, or fail the run. */
async function checkpoint(name, check, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    let s = null;
    try { s = await state(); } catch { /* core still booting */ }
    if (s) {
      const got = check(s);
      if (got) {
        console.log(`  PASS  ${name}${typeof got === 'string' ? `: ${got}` : ''}`);
        return s;
      }
    }
    if (Date.now() - t0 > timeoutMs) {
      console.error(`  FAIL  ${name} (timed out after ${timeoutMs / 1000}s)`);
      if (s) console.error(`        last state: screen=${s.screen} phase=${s.phase} ` +
        `match=${s.match?.displayName} started=${s.matchStartedAt} hub=${s.hubActive}`);
      shutdown(1);
    }
    await sleep(150);
  }
}

console.log(`Offline field validation at ${SPEED}x. Fake arena :${ARENA_PORT}, core :${CORE_PORT}\n`);

boot('arena', ['--experimental-strip-types', 'apps/core/src/ingest/cheesy/fake-arena.ts',
  '--port', String(ARENA_PORT), '--speed', String(SPEED)]);
await sleep(700);
boot('core', ['--experimental-strip-types', 'apps/core/src/index.ts',
  '--cheesy', '--cheesy-host', `127.0.0.1:${ARENA_PORT}`,
  '--display-id', 'simdesk', '--port', String(CORE_PORT)]);

// The hub goes authoritative per-alliance during teleop shifts; collect what we
// see so the alternation itself can be asserted at the end.
const hubsSeen = new Set();
const hubWatcher = setInterval(async () => {
  try {
    const s = await state();
    if (s.hubAuthoritative) hubsSeen.add(s.hubAuthoritative);
  } catch { /* not up yet */ }
}, 120);

// ---- the checkpoint sequence of one real match ------------------------------
await checkpoint('bridge up, arena.status reports cheesy connected',
  s => s.connected?.cheesy === true);

const first = await checkpoint('match loads -> alliance overview, teams named from the field',
  s => s.match?.displayName?.startsWith('Qualification')
    && s.screen === 'overview'
    && s.match.red?.[0]?.name === 'The Funky Monkeys'
    && `match ${s.match.displayName}`);
const firstMatch = Number(first.match.displayName.replace(/\D+/g, ''));

await checkpoint('ARMED before the countdown, score bar up while the match has not started',
  s => s.screen === 'match' && s.matchStartedAt === null && s.phase === 'pre');

await checkpoint('match starts, clock running, still on the score bar',
  s => s.matchStartedAt !== null && s.screen === 'match');

await checkpoint('authoritative score arrives from the field',
  s => s.confidence === 'authoritative'
    && (s.score.red.total > 0 || s.score.blue.total > 0)
    && `red ${s.score.red.total} · blue ${s.score.blue.total}`);

await checkpoint('auto winner decided on FUEL alone: blue, despite red\'s 15-point climb',
  s => s.autoWinnerKnown === true && s.autoWinner === 'blue');

await checkpoint('field-authoritative hub state drives the indicator',
  s => s.hubAuthoritative !== null && `hub ${s.hubAuthoritative}`);

await checkpoint('Energized RP flips when fuel crosses 100',
  s => s.score.red.rp.energized === true || s.score.blue.rp.energized === true,
  240_000);

await checkpoint('Traversal RP flips when tower crosses 50 (blue climbs)',
  s => s.score.blue.rp.traversal === true, 240_000);

await checkpoint('buzzer, match ends, clock stops',
  s => s.matchEndedAt !== null, 240_000);

await checkpoint('score posts -> final score screen',
  s => s.scorePostedAt !== null && s.screen === 'score');

await checkpoint('next match load returns program to the overview',
  s => s.screen === 'overview'
    && Number(s.match?.displayName?.replace(/\D+/g, '') ?? 0) > firstMatch
    && `now on ${s.match.displayName}`, 120_000);

clearInterval(hubWatcher);
if (hubsSeen.has('red') && hubsSeen.has('blue')) {
  console.log(`  PASS  hub alternated across shifts, saw: ${[...hubsSeen].join(', ')}`);
} else {
  console.error(`  FAIL  hub never alternated, saw only: ${[...hubsSeen].join(', ') || 'nothing'}`);
  shutdown(1);
}

// ---- side effects that must have happened -----------------------------------
const markers = await (await fetch(`${BASE}/api/markers?since=1`)).json();
if (Array.isArray(markers) && markers.length > 0) {
  console.log(`  PASS  score deltas produced ${markers.length} automatic replay markers`);
} else {
  console.error('  FAIL  no automatic replay markers landed');
  shutdown(1);
}

const bridge = await (await fetch(`${BASE}/api/cheesy`)).json();
if (bridge.bridged && bridge.connected && bridge.requests > 0) {
  console.log(`  PASS  bridge audit log recorded ${bridge.requests} requests, all on the allowlist`);
} else {
  console.error(`  FAIL  bridge audit unexpected: ${JSON.stringify(bridge)}`);
  shutdown(1);
}

console.log('\nAll checkpoints passed. The full Cheesy path works against dummy field data.');
shutdown(0);
