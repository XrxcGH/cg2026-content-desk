import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { Vitals, type Vital, type VitalsDeps, type VitalsReport } from './vitals.ts';
import { DEFAULTS, type Config } from './config.ts';

const cfg = (over: Partial<Config> = {}): Config =>
  ({ ...structuredClone(DEFAULTS), ...over });

const base = (over: Partial<VitalsDeps> = {}): VitalsDeps => ({
  bus: new EventBus(), config: cfg(), root: process.cwd(), ...over,
});

const find = (report: VitalsReport, id: string): Vital =>
  report.checks.find(c => c.id === id)!;

test('a bare desk reports off rather than broken', async () => {
  // Nothing configured is the normal state of a laptop at a kitchen table, and
  // it must not look like a failing event.
  const r = await new Vitals(base()).report();
  assert.equal(find(r, 'recorder').level, 'off');
  assert.equal(find(r, 'obs').level, 'off');
  assert.equal(find(r, 'field').level, 'off');
  assert.equal(find(r, 'publish').level, 'off');
  assert.equal(r.blockers.length, 0, 'off is not a blocker');
  assert.notEqual(r.worst, 'fail');
});

test('a stopped recording source is a blocking failure, named', async () => {
  const recorder = {
    status: [
      { id: 'program', running: true },
      { id: 'cam1', running: false },
    ],
  } as unknown as VitalsDeps['recorder'];

  const r = await new Vitals(base({ recorder })).report();
  const rec = find(r, 'recorder');
  assert.equal(rec.level, 'fail');
  assert.match(rec.detail, /cam1/);
  assert.ok(r.blockers.some(b => b.id === 'recorder'));
});

test('disk is reported in hours of recording, not gigabytes', async () => {
  // "38GB free" means nothing to the person deciding whether to start the day.
  const r = await new Vitals(base()).report();
  assert.match(find(r, 'disk').detail, /hours of recording/);
});

test('publishing enabled with no credentials blocks doors', async () => {
  const config = cfg();
  config.publish.enabled = true;
  const r = await new Vitals(base({ config })).report();
  const pub = find(r, 'publish');
  assert.equal(pub.level, 'fail');
  assert.match(pub.detail, /youtube\.clientId/);
  assert.ok(pub.fix, 'a blocker without a fix is just bad news');
  assert.ok(r.blockers.some(b => b.id === 'publish'));
});

test('a muted microphone is surfaced, because nothing else complains', async () => {
  // The single most common broadcast failure: the show runs, the graphics are
  // right, and forty minutes of it have no commentary.
  const obs = {
    connected: true,
    streamStatus: async () => ({ outputActive: false }),
    request: async (type: string, data?: { inputName?: string }) => {
      if (type === 'GetInputList') {
        return { inputs: [
          { inputName: 'Announcer Mic', inputKind: 'wasapi_input_capture' },
          { inputName: 'Desk Mic', inputKind: 'wasapi_input_capture' },
          { inputName: 'Field Cam', inputKind: 'dshow_input' },
        ] };
      }
      if (type === 'GetInputMute') return { inputMuted: data?.inputName === 'Announcer Mic' };
      return {};
    },
  } as unknown as VitalsDeps['obs'];

  const r = await new Vitals(base({ obs })).report();
  const mics = find(r, 'mics');
  assert.equal(mics.level, 'warn');
  assert.match(mics.detail, /Announcer Mic/);
  assert.doesNotMatch(mics.detail, /Field Cam/, 'a camera is not a microphone');
});

test('one unreadable input does not hide the other microphones', async () => {
  const obs = {
    connected: true,
    streamStatus: async () => ({ outputActive: false }),
    request: async (type: string, data?: { inputName?: string }) => {
      if (type === 'GetInputList') {
        return { inputs: [
          { inputName: 'Mic A', inputKind: 'wasapi_input_capture' },
          { inputName: 'Mic B', inputKind: 'wasapi_input_capture' },
        ] };
      }
      if (data?.inputName === 'Mic A') throw new Error('gone');
      return { inputMuted: true };
    },
  } as unknown as VitalsDeps['obs'];

  const r = await new Vitals(base({ obs })).report();
  assert.match(find(r, 'mics').detail, /Mic B/);
});

test('a dropping stream is called out with what to do about it', async () => {
  const obs = {
    connected: true,
    streamStatus: async () => ({
      outputActive: true, outputSkippedFrames: 900, outputTotalFrames: 10_000,
    }),
    request: async () => ({ inputs: [] }),
  } as unknown as VitalsDeps['obs'];

  const r = await new Vitals(base({ obs })).report();
  const health = find(r, 'stream-health');
  assert.equal(health.level, 'fail');
  assert.match(health.fix ?? '', /bitrate|degraded/i);
});

test('a check that throws reports unknown instead of taking the report down', async () => {
  // A health report that cannot be read when things are going wrong is worse
  // than no health report.
  const obs = {
    connected: true,
    streamStatus: async () => { throw new Error('socket died'); },
    request: async () => { throw new Error('socket died'); },
  } as unknown as VitalsDeps['obs'];

  const r = await new Vitals(base({ obs })).report();
  assert.equal(find(r, 'obs').level, 'unknown');
  assert.ok(r.checks.length > 3, 'the other checks still ran');
});

test('house audio: none armed warns, two armed fails', async () => {
  const withPlayers = (armed: number) => ({
    snapshot: { players: { alive: armed, armed } },
  } as unknown as VitalsDeps['audio']);

  assert.equal(find(await new Vitals(base({ audio: withPlayers(0) })).report(), 'house').level, 'warn');
  assert.equal(find(await new Vitals(base({ audio: withPlayers(1) })).report(), 'house').level, 'ok');
  // Two armed players usually means one of them is the machine OBS captures.
  assert.equal(find(await new Vitals(base({ audio: withPlayers(2) })).report(), 'house').level, 'fail');
});
