/**
 * Default question bank, in SESSIONS.
 *
 * A session is one round the gym plays in one gap between matches: six
 * questions, about four minutes with the reveal beats. The next gap starts the
 * next session, scores carry, and the leaderboard keeps building all day. That
 * shape exists because the alternative is what actually happens otherwise: a
 * host opens question one at 10am, the field calls a match mid-question, and
 * the game never gets picked up again.
 *
 * Thirty-six questions ship here so the game runs with nobody preparing
 * anything. That is the real requirement. The desk manager on the day is
 * queueing matches and chasing a missing drive coach; writing trivia is the
 * first thing to fall off, and a bank that needs authoring is a bank that
 * stays empty.
 *
 * The REBUILT session doubles as audience education: someone who answers "how
 * much fuel earns the Energized RP?" now understands the badge on the score
 * bar for the rest of the day.
 *
 * Every answer here is either a checkable outside fact or a fact about this
 * event. Nothing is invented about WRRF's history, because a trivia answer
 * that is wrong in front of the people who were there is worse than no trivia.
 *
 * Drop a `data/trivia.json` (same shape, `session` included) next to the event
 * log to replace the bank per event without touching code.
 */

import type { TriviaQuestion } from './model.ts';

/** Session names, in playing order. Exported so the host console can label
 *  them before anything has been asked. */
export const SESSIONS = [
  'Round 1 · How REBUILT works',
  'Round 2 · FIRST history',
  'Round 3 · WRRF and CalGames',
  'Round 4 · The machine',
  'Round 5 · Bay Area robotics',
  'Round 6 · Between matches',
] as const;

export const DEFAULT_QUESTIONS: TriviaQuestion[] = [
  // ---- Round 1: the game on the field right now ---------------------------
  {
    id: 'rebuilt-energized',
    session: SESSIONS[0],
    category: '2026 REBUILT',
    text: 'How many fuel points earn an alliance the ENERGIZED ranking point?',
    options: ['50', '100', '250', '360'],
    answer: 1,
  },
  {
    id: 'rebuilt-supercharged',
    session: SESSIONS[0],
    category: '2026 REBUILT',
    text: 'The SUPERCHARGED bonus takes how many fuel points?',
    options: ['180', '240', '300', '360'],
    answer: 3,
  },
  {
    id: 'rebuilt-traversal',
    session: SESSIONS[0],
    category: '2026 REBUILT',
    text: 'TRAVERSAL is earned at how many tower points?',
    options: ['30', '40', '50', '60'],
    answer: 2,
  },
  {
    id: 'rebuilt-hub',
    session: SESSIONS[0],
    category: '2026 REBUILT',
    text: 'Fuel scored into an INACTIVE hub is worth...',
    options: ['1 point', '2 points', 'Half a point', 'Nothing at all'],
    answer: 3,
  },
  {
    id: 'rebuilt-auto-winner',
    session: SESSIONS[0],
    category: '2026 REBUILT',
    text: 'Winning AUTO (which decides who owns the later hub shifts) is judged on...',
    options: ['Total auto points', 'Auto fuel alone', 'Auto tower alone', 'A referee vote'],
    answer: 1,
  },
  {
    id: 'rebuilt-shifts',
    session: SESSIONS[0],
    category: '2026 REBUILT',
    text: 'Winning auto buys an alliance which hub shifts?',
    options: ['The early ones', 'The later ones', 'All of them', 'None: shifts are random'],
    answer: 1,
  },

  // ---- Round 2: where all of this came from -------------------------------
  {
    id: 'frc-first',
    session: SESSIONS[1],
    category: 'FIRST history',
    text: 'FIRST (as in FIRST Robotics) stands for...',
    options: [
      'For Inspiration and Recognition of Science and Technology',
      'Future Innovators in Robotics, Science and Technology',
      'Foundation for Integrated Robotics and STEM Teaching',
      'It is not an acronym',
    ],
    answer: 0,
  },
  {
    id: 'frc-founder',
    session: SESSIONS[1],
    category: 'FIRST history',
    text: 'FIRST was founded in 1989 by inventor...',
    options: ['Woodie Flowers', 'Dean Kamen', 'Grant Imahara', 'Limor Fried'],
    answer: 1,
  },
  {
    id: 'frc-kickoff',
    session: SESSIONS[1],
    category: 'FIRST history',
    text: 'The FRC season traditionally begins with Kickoff in which month?',
    options: ['September', 'November', 'January', 'March'],
    answer: 2,
  },
  {
    id: 'frc-kamen-invention',
    session: SESSIONS[1],
    category: 'FIRST history',
    text: 'Dean Kamen is also known for inventing which two-wheeled vehicle?',
    options: ['The Segway', 'The Vespa', 'The penny-farthing', 'The hoverboard'],
    answer: 0,
  },
  {
    id: 'frc-gracious',
    session: SESSIONS[1],
    category: 'FIRST history',
    text: '"Gracious Professionalism", the idea at the centre of FIRST, was coined by...',
    options: ['Dean Kamen', 'Woodie Flowers', 'A student in 1997', 'NASA'],
    answer: 1,
  },
  {
    id: 'frc-impact-award',
    session: SESSIONS[1],
    category: 'FIRST history',
    text: "FIRST's most prestigious award, the Impact Award, used to be called the...",
    options: ["Chairman's Award", 'Founders Award', 'Excellence Award', 'Kamen Cup'],
    answer: 0,
  },

  // ---- Round 3: this event, this weekend ----------------------------------
  {
    id: 'calgames-host',
    session: SESSIONS[2],
    category: 'CalGames',
    text: 'CalGames 2026 is presented by which organization?',
    options: [
      'Western Region Robotics Forum',
      'Silicon Valley Robotics League',
      'FIRST California',
      'NorCal FIRST Alliance',
    ],
    answer: 0,
  },
  {
    id: 'calgames-venue',
    session: SESSIONS[2],
    category: 'CalGames',
    text: 'Where is CalGames 2026 being played?',
    options: ['San Jose State', 'Woodside High School', "Levi's Stadium", 'UC Berkeley'],
    answer: 1,
  },
  {
    id: 'wrrf-name',
    session: SESSIONS[2],
    category: 'CalGames',
    text: 'The WRRF in "WRRF presents CalGames" stands for...',
    options: [
      'Western Region Robotics Forum',
      'West Regional Robot Federation',
      'Western Robotics and Racing Foundation',
      'We Really Really Fabricate',
    ],
    answer: 0,
  },
  {
    id: 'calgames-offseason',
    session: SESSIONS[2],
    category: 'CalGames',
    text: 'CalGames is an OFF-SEASON event, which means...',
    options: [
      'It is played outside the official FRC season, for fun and practice',
      'It counts toward championship qualification',
      'Only rookie teams may enter',
      'Robots must be built that weekend',
    ],
    answer: 0,
  },
  {
    id: 'wrrf-colors',
    session: SESSIONS[2],
    category: 'CalGames',
    text: 'Look around you. WRRF purple, gold and which third colour make up this weekend\'s branding?',
    options: ['Green', 'Orange', 'Teal', 'Silver'],
    answer: 0,
  },
  {
    id: 'calgames-month',
    session: SESSIONS[2],
    category: 'CalGames',
    text: 'CalGames 2026 is being played in which month?',
    options: ['August', 'October', 'December', 'March'],
    answer: 1,
  },

  // ---- Round 4: the robots and the field tech -----------------------------
  {
    id: 'frc-cheesy-arena',
    session: SESSIONS[3],
    category: 'Field tech',
    text: 'Cheesy Arena, the field software running this event, was originally built by...',
    options: ['FIRST HQ', 'Team 254', 'Team 1678', 'The Blue Alliance'],
    answer: 1,
  },
  {
    id: 'frc-fms',
    session: SESSIONS[3],
    category: 'Field tech',
    text: 'In FRC, what does FMS stand for?',
    options: [
      'Field Management System',
      'Full Match Scoring',
      'FIRST Match Server',
      'Field Marshal Station',
    ],
    answer: 0,
  },
  {
    id: 'frc-robots-on-field',
    session: SESSIONS[3],
    category: 'Field tech',
    text: 'How many robots are on the field during a standard qualification match?',
    options: ['4', '6', '8', '10'],
    answer: 1,
  },
  {
    id: 'frc-alliance-size',
    session: SESSIONS[3],
    category: 'Field tech',
    text: 'A qualification alliance is made up of how many teams?',
    options: ['2', '3', '4', '6'],
    answer: 1,
  },
  {
    id: 'frc-roborio',
    session: SESSIONS[3],
    category: 'Field tech',
    text: 'The main controller in the middle of nearly every FRC robot is called the...',
    options: ['roboRIO', 'Raspberry Pi', 'Arduino Mega', 'cRIO-9074'],
    answer: 0,
  },
  {
    id: 'frc-estop',
    session: SESSIONS[3],
    category: 'Field tech',
    text: 'If something goes wrong mid-match, the big red button at the driver station does what?',
    options: [
      'Stops that robot immediately',
      'Pauses the match clock',
      'Calls a referee over',
      'Restarts the robot code',
    ],
    answer: 0,
  },

  // ---- Round 5: the neighbourhood -----------------------------------------
  {
    id: 'frc-846',
    session: SESSIONS[4],
    category: 'Bay Area FRC',
    text: 'Team 846, The Funky Monkeys, is based at which school?',
    options: ['Lynbrook High', 'Homestead High', 'Woodside High', 'Bellarmine Prep'],
    answer: 0,
  },
  {
    id: 'frc-1868',
    session: SESSIONS[4],
    category: 'Bay Area FRC',
    text: 'The Space Cookies (1868) are famously supported by which organization?',
    options: ['SpaceX', 'NASA Ames', 'Lockheed Martin', 'Blue Origin'],
    answer: 1,
  },
  {
    id: 'frc-254',
    session: SESSIONS[4],
    category: 'Bay Area FRC',
    text: 'Team 254, the winningest team in FRC history, is known as...',
    options: ['The Cheesy Poofs', 'Citrus Circuits', 'Spectrum', 'The RoboLords'],
    answer: 0,
  },
  {
    id: 'frc-971',
    session: SESSIONS[4],
    category: 'Bay Area FRC',
    text: 'Team 971 from Mountain View competes under which name?',
    options: ['Spartan Robotics', 'Cyber Blue', 'The Holy Cows', 'Robo Vikings'],
    answer: 0,
  },
  {
    id: 'frc-chezy-champs',
    session: SESSIONS[4],
    category: 'Bay Area FRC',
    text: 'Chezy Champs, another well-known California off-season event, is hosted by...',
    options: ['Team 254', 'Team 971', 'Team 1678', 'WRRF'],
    answer: 0,
  },
  {
    id: 'frc-blue-alliance',
    session: SESSIONS[4],
    category: 'Bay Area FRC',
    text: 'The Blue Alliance is best known as...',
    options: [
      'The community site with every match result and video',
      'A California team alliance',
      "FIRST's official scoring system",
      'A robot parts supplier',
    ],
    answer: 0,
  },

  // ---- Round 6: nothing to do with robots ---------------------------------
  {
    id: 'fun-bones',
    session: SESSIONS[5],
    category: 'Between matches',
    text: 'How many bones are there in the adult human body?',
    options: ['186', '206', '226', '246'],
    answer: 1,
  },
  {
    id: 'fun-red-planet',
    session: SESSIONS[5],
    category: 'Between matches',
    text: 'Which planet is known as the Red Planet?',
    options: ['Venus', 'Mars', 'Jupiter', 'Mercury'],
    answer: 1,
  },
  {
    id: 'fun-golden-gate',
    session: SESSIONS[5],
    category: 'Between matches',
    text: 'The Golden Gate Bridge is painted a colour officially called...',
    options: ['International Orange', 'Signal Red', 'Bay Rust', 'Sunset Coral'],
    answer: 0,
  },
  {
    id: 'fun-speed-light',
    session: SESSIONS[5],
    category: 'Between matches',
    text: 'Roughly how fast does light travel in a vacuum?',
    options: [
      '300 kilometres per second',
      '3,000 kilometres per second',
      '300,000 kilometres per second',
      '300 million kilometres per second',
    ],
    answer: 2,
  },
  {
    id: 'fun-honey',
    session: SESSIONS[5],
    category: 'Between matches',
    text: 'Which of these foods essentially never spoils?',
    options: ['Honey', 'Milk', 'Bread', 'Rice pudding'],
    answer: 0,
  },
  {
    id: 'fun-octopus-hearts',
    session: SESSIONS[5],
    category: 'Between matches',
    text: 'How many hearts does an octopus have?',
    options: ['One', 'Two', 'Three', 'Eight'],
    answer: 2,
  },
];
