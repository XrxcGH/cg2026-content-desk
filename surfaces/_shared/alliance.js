/**
 * The alliance as it was picked, not just the three robots on the field.
 *
 * CalGames runs Championship-division style selection: four teams are chosen
 * per alliance and no backup is called later. Only three ever play a given
 * match, so `match.red` is the three on the field and is the right answer for
 * anything about THIS match. The fourth team is still on the alliance, and
 * anything about the ALLIANCE (the selection board, the result card, the
 * awards) has to name all four or it is telling a team they were not there.
 *
 * Cheesy Arena's match record has only three team slots, so the roster comes
 * from joining the playoff seed on the match against the alliance list from
 * selection. Names are filled from whoever we already know: the teams on the
 * field carry theirs, and the rankings poll covers the rest.
 */

/** @returns the full alliance in pick order, or the on-field three if unknown. */
export function allianceRoster(state, side) {
  const onField = state?.match?.[side] ?? [];
  const seed = side === 'red' ? state?.match?.redAlliance : state?.match?.blueAlliance;
  if (!seed) return onField;                       // qualification match

  const picked = (state?.selection?.alliances ?? []).find(a => a.id === seed)?.teams;
  // Selection has not run, or this alliance is still empty: the field wins.
  if (!picked?.length) return onField;

  const known = new Map(onField.map(t => [t.number, t]));
  const named = new Map((state?.rankings ?? []).map(r => [r.team, r.name]));
  return picked.map(number =>
    known.get(number) ?? { number, name: named.get(number) ?? '' });
}

/** True when this team is on the alliance but not on the field this match. */
export function isReserve(state, side, number) {
  return !(state?.match?.[side] ?? []).some(t => t.number === number);
}
