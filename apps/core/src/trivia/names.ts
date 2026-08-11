/**
 * Display-name screening for crowd trivia.
 *
 * Anyone in the gym can type a name and it goes on a projector in front of a
 * room full of children, their parents, and the school that lent us the
 * building. Somebody will try it. This is the cheapest possible insurance
 * against the one that lands during the awards ceremony.
 *
 * Three decisions worth stating, because each has an obvious wrong answer:
 *
 * 1. REJECT, do not silently clean. A name quietly replaced with "Player 12"
 *    reads to the person who typed it as a bug, and they type it again. Told
 *    "pick another name", they pick another name.
 * 2. Fold lookalikes before matching, because "a55hole" is the entire
 *    technique. Leet substitutions and repeated letters collapse first.
 * 3. Match WHOLE WORDS, in two passes, because one pass cannot do both jobs.
 *    Collapsing separators is what catches "F U C K" and "f.u.c.k"; it also
 *    destroys the word boundaries that keep "Shitake" and "Dickinson" out of
 *    trouble. So there are two forms: a spaced form matched word by word, and
 *    a fully collapsed form matched only against the WHOLE name. The
 *    Scunthorpe problem is real, and a filter that rejects somebody's actual
 *    surname teaches the room the game is broken, which costs more than a
 *    "damn" on a leaderboard.
 *
 * This is not exhaustive and cannot be. Vowel-swapping ("f0ck" folds to
 * "fock") gets through, and closing that needs vowel-equivalence rules that
 * would start rejecting real names. It is a doorstop sized for the actual
 * threat, which is a bored teenager rather than a determined one, and the host
 * console can remove anything that gets past it.
 */

/** Leet and lookalike folding, applied before any comparison. */
const FOLD: Record<string, string> = {
  '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a',
  '5': 's', '$': 's', '7': 't', '8': 'b', '9': 'g', '+': 't',
};

/**
 * Words that may not appear whole. Kept short and obvious on purpose: every
 * addition is a chance to reject somebody's actual name, and the host can
 * always remove what gets through. Slurs are the category worth being strict
 * about; mild profanity is worth being relaxed about.
 */
const BANNED_STEMS = [
  'fuck', 'shit', 'cunt', 'bitch', 'dick', 'cock', 'penis', 'vagina',
  'nigger', 'nigga', 'faggot', 'retard', 'rape', 'nazi', 'hitler',
  'whore', 'slut', 'anus', 'asshole', 'bastard', 'wank', 'twat',
];

/** Impersonating the event's own voice is its own problem. */
const RESERVED = ['admin', 'moderator', 'referee', 'head ref', 'fta', 'announcer', 'calgames', 'wrrf'];

/**
 * Endings that still leave the word the word. "fucking" and "bitches" are the
 * same problem as their stems; "shitake" and "dickinson" are not, which is
 * exactly why this is a short list of real suffixes and not a prefix test.
 */
const SUFFIXES = ['', 's', 'es', 'ed', 'ing', 'er', 'ers', 'y', 'ie', 'ies', 'ish', 'head', 'face', 'hole'];

/**
 * Fold lookalikes and collapse runs, keeping anything that is not a letter as
 * a separator. This is the form that still has words in it.
 */
function foldWords(raw: string): string[] {
  const folded = [...raw.toLowerCase()].map(c => FOLD[c] ?? c).join('');
  return folded
    .split(/[^a-z]+/)
    .filter(Boolean)
    // Runs collapse to two, not one: "fuuuuck" and "fuuck" are the same word,
    // and squashing to one would turn "bookkeeper" into something else.
    .map(w => w.replace(/(.)\1{2,}/g, '$1$1'));
}

/**
 * The same folding with separators removed, so "F U C K" and "f.u.c.k" both
 * land on one word. Only ever compared against a whole banned word: used for
 * substring matching it would flag every innocent name containing one.
 */
export function normalizeName(raw: string): string {
  return foldWords(raw).join('');
}

/**
 * Checked at both collapse depths. Runs normally collapse to two so that
 * ordinary doubled letters survive, but "fuuuuck" lands on "fuuck", so the
 * fully-squashed variant is tested as well. Squashing can only ADD matches:
 * it is compared against the banned list and nothing else, so the cost is a
 * real name that squashes exactly onto a banned word, and there is not one.
 */
const isBannedWord = (word: string): boolean => {
  const squashed = word.replace(/(.)\1+/g, '$1');
  return [word, squashed].some(form =>
    BANNED_STEMS.some(stem => SUFFIXES.some(suf => form === stem + suf)));
};

export interface NameVerdict {
  ok: boolean;
  /** Shown to the person who typed it. Never names the matched word. */
  reason?: string;
}

/**
 * Is this name allowed on the big screen?
 *
 * The reason deliberately never quotes the offending word back: printing it in
 * an error message on a shared phone is the same problem one step removed, and
 * "pick another name" is all the information anybody needs.
 */
export function screenName(raw: string): NameVerdict {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'A name is required.' };

  const flat = trimmed.toLowerCase();
  if (RESERVED.some(r => flat === r || flat.startsWith(`${r} `))) {
    return { ok: false, reason: 'That name is reserved for event staff. Pick another one.' };
  }

  const words = foldWords(trimmed);
  if (!words.length) {
    // All punctuation or emoji. It renders as a blank row on the leaderboard,
    // which reads as a rendering fault rather than somebody's choice.
    return { ok: false, reason: 'Use some letters in your name.' };
  }

  // Pass one: any single word that IS a banned word, with or without an
  // ordinary ending. Word by word, so a stem buried inside a longer real word
  // is left alone.
  if (words.some(isBannedWord)) {
    return { ok: false, reason: 'Pick a different name for the big screen.' };
  }

  // Pass two: the whole name with the spacing taken out, for the "F U C K"
  // technique. Only an exact match counts here, because substring matching on
  // this form is what would reject Scunthorpe.
  if (words.length > 1 && isBannedWord(words.join(''))) {
    return { ok: false, reason: 'Pick a different name for the big screen.' };
  }

  return { ok: true };
}
