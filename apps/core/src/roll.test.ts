import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The number-roll easing, pinned as arithmetic.
 *
 * `roll()` itself lives in a browser module and needs a DOM, but the bug it had
 * was pure maths: the progress fraction was clamped at the top and not the
 * bottom, and the ease curve explodes downward for negative input. A score bar
 * showed "-18 FUEL" while the desk state said 119 the whole time.
 *
 * The two clamps and the curve are reproduced here exactly. If somebody
 * "simplifies" the clamp back out, this fails.
 */
const ease = (p: number): number => 1 - (1 - p) ** 3;

const rolled = (from: number, to: number, rawP: number): number => {
  const p = Math.max(0, Math.min(1, rawP));
  return Math.round(from + (to - from) * ease(p));
};

test('the ease curve explodes downward for negative progress', () => {
  // Why the bottom clamp has to exist at all: this is the value the element
  // would have rendered, unclamped.
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.equal(ease(-1), -7, 'seven times the distance, in the wrong direction');
});

test('a frame stamped before the call that scheduled it renders the start value', () => {
  // The real case: t0 comes from performance.now(), `now` is the rAF frame
  // timestamp, and the first frame can be fractionally earlier.
  assert.equal(rolled(119, 0, -0.02), 119);
  assert.equal(rolled(0, 119, -0.5), 0);
});

test('a roll never leaves the range it was given', () => {
  for (const [from, to] of [[0, 119], [119, 0], [88, 91], [1200, 3]] as const) {
    for (const p of [-2, -0.5, -0.001, 0, 0.25, 0.5, 0.75, 1, 1.5, 12]) {
      const v = rolled(from, to, p);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      assert.ok(v >= lo && v <= hi,
        `roll(${from} -> ${to}) at p=${p} produced ${v}, outside [${lo}, ${hi}]`);
    }
  }
});

test('a score can never render negative on the way to zero', () => {
  // The specific on-air symptom, as a regression test.
  for (const p of [-3, -1, -0.1, 0, 0.5, 1]) {
    assert.ok(rolled(119, 0, p) >= 0, `rendered ${rolled(119, 0, p)}`);
  }
});
