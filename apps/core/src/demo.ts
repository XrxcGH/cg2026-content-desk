/**
 * Simulated match driver. Development only — it exists so graphics can be
 * built in July without a field, and so a new volunteer can see the whole
 * show loop within ten seconds of `npm start -- --demo`.
 *
 * Real CalGames 2025 teams, because placeholder names hide layout problems:
 * "Team A" fits anywhere, "Homestead Robotics" does not.
 */

import type { EventBus } from './bus.ts';
import { REBUILT, type Alliance } from './types.ts';

const RED = [
  { number: 846, name: 'The Funky Monkeys' },
  { number: 1868, name: 'Space Cookies' },
  { number: 253, name: 'Boba Bots' },
];
const BLUE = [
  { number: 100, name: 'The Wildhats' },
  { number: 115, name: 'MVRT' },
  { number: 670, name: 'Homestead Robotics' },
];

export function startDemo(bus: EventBus): void {
  console.log('[demo] simulated match loop running');
  let matchNumber = 41;

  const loop = async (): Promise<void> => {
    for (;;) {
      matchNumber++;
      bus.emit({
        type: 'match.loaded',
        source: 'cheesy',
        payload: {
          id: `q${matchNumber}`,
          displayName: `Qualification ${matchNumber}`,
          red: RED, blue: BLUE,
        },
      });

      await sleep(6000);
      bus.emit({ type: 'match.prestart', source: 'cheesy' });
      await sleep(2500);
      bus.emit({ type: 'match.start', source: 'cheesy' });

      const score = { red: { fuel: 0, tower: 0 }, blue: { fuel: 0, tower: 0 } };

      // Drive scoring off the real clock so hub state and endgame land right.
      const scoring = setInterval(() => {
        const c = bus.state.matchClock;
        if (c === null || c < REBUILT.AUTO_START || c > REBUILT.MATCH_END) return;
        const hub = bus.state.hubActive;

        for (const side of ['red', 'blue'] as Alliance[]) {
          if (hub !== 'both' && hub !== side) continue;
          if (Math.random() > 0.55) continue;
          const amount = 1 + Math.floor(Math.random() * 4);
          score[side].fuel += amount;
          bus.emit({
            type: 'score.delta', source: 'cheesy',
            payload: { alliance: side, field: 'fuel', amount },
          });
        }

        if (c > REBUILT.ENDGAME_START + 8 && Math.random() < 0.05) {
          const side: Alliance = Math.random() < 0.5 ? 'red' : 'blue';
          if (score[side].tower >= 90) return;
          const level = (1 + Math.floor(Math.random() * 3)) as 1 | 2 | 3;
          score[side].tower += REBUILT.TOWER_TELEOP[level];
          bus.emit({
            type: 'score.delta', source: 'cheesy',
            payload: { alliance: side, field: 'tower', amount: REBUILT.TOWER_TELEOP[level] },
          });
        }
      }, 400);

      await sleep((REBUILT.MATCH_END - REBUILT.AUTO_START) * 1000 + 1500);
      clearInterval(scoring);

      await sleep(2500);
      bus.emit({ type: 'match.score_posted', source: 'cheesy' });
      await sleep(9000);
    }
  };

  void loop();
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
