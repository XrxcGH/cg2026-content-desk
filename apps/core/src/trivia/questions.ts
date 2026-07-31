/**
 * Default question bank. FRC lore, Bay Area color, and 2026 REBUILT rules:
 * the REBUILT ones double as audience education: someone who answers "how much
 * fuel earns the Energized RP?" now understands the badge on the score bar.
 *
 * Drop a `data/trivia.json` (same shape) next to the event log to replace the
 * bank per event without touching code.
 */

import type { TriviaQuestion } from './model.ts';

export const DEFAULT_QUESTIONS: TriviaQuestion[] = [
  {
    id: 'rebuilt-energized',
    category: '2026 REBUILT',
    text: 'How many fuel points earn an alliance the ENERGIZED ranking point?',
    options: ['50', '100', '250', '360'],
    answer: 1,
  },
  {
    id: 'rebuilt-supercharged',
    category: '2026 REBUILT',
    text: 'The SUPERCHARGED bonus takes how many fuel points?',
    options: ['180', '240', '300', '360'],
    answer: 3,
  },
  {
    id: 'rebuilt-traversal',
    category: '2026 REBUILT',
    text: 'TRAVERSAL is earned at how many tower points?',
    options: ['30', '40', '50', '60'],
    answer: 2,
  },
  {
    id: 'rebuilt-hub',
    category: '2026 REBUILT',
    text: 'Fuel scored into an INACTIVE hub is worth…',
    options: ['1 point', '2 points', 'Half a point', 'Nothing at all'],
    answer: 3,
  },
  {
    id: 'rebuilt-auto-winner',
    category: '2026 REBUILT',
    text: 'Winning AUTO (which decides who owns the later hub shifts) is judged on…',
    options: ['Total auto points', 'Auto fuel alone', 'Auto tower alone', 'A referee vote'],
    answer: 1,
  },
  {
    id: 'frc-846',
    category: 'Bay Area FRC',
    text: 'Team 846, The Funky Monkeys, are based at which school?',
    options: ['Lynbrook High', 'Homestead High', 'Woodside High', 'Bellarmine Prep'],
    answer: 0,
  },
  {
    id: 'frc-1868',
    category: 'Bay Area FRC',
    text: 'The Space Cookies (1868) are famously supported by which organization?',
    options: ['SpaceX', 'NASA Ames', 'Lockheed Martin', 'Blue Origin'],
    answer: 1,
  },
  {
    id: 'frc-254',
    category: 'Bay Area FRC',
    text: 'Team 254, the winningest team in FRC history, is known as…',
    options: ['The Cheesy Poofs', 'Citrus Circuits', 'Spectrum', 'The RoboLords'],
    answer: 0,
  },
  {
    id: 'frc-first',
    category: 'FRC history',
    text: 'FIRST (as in FIRST Robotics) stands for…',
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
    category: 'FRC history',
    text: 'FIRST was founded in 1989 by inventor…',
    options: ['Woodie Flowers', 'Dean Kamen', 'Grant Imahara', 'Limor Fried'],
    answer: 1,
  },
  {
    id: 'frc-kickoff',
    category: 'FRC history',
    text: 'The FRC season traditionally begins with Kickoff in which month?',
    options: ['September', 'November', 'January', 'March'],
    answer: 2,
  },
  {
    id: 'calgames-host',
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
    category: 'CalGames',
    text: 'Where is CalGames 2026 being played?',
    options: ['San Jose State', 'Woodside High School', 'Levi’s Stadium', 'UC Berkeley'],
    answer: 1,
  },
  {
    id: 'frc-cheesy-arena',
    category: 'Field tech',
    text: 'Cheesy Arena, the field software running this event, was originally built by…',
    options: ['FIRST HQ', 'Team 254', 'Team 1678', 'The Blue Alliance'],
    answer: 1,
  },
];
