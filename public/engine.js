// Pure game rules. No Cloudflare APIs in here on purpose:
// the client imports the same file to predict moves locally,
// and you can unit test it with plain node.

export const COLOURS = ['amber', 'teal', 'coral', 'indigo'];
export const MAX_SEATS = 8;
export const RACE_SIZE = 10;
export const READY_PILES = 3;
export const DEFAULT_TARGET = 75;

// A card is a single integer 0..319 so that broadcasts stay tiny.
//   owner = seat index 0..7,  colour = 0..3,  value = 1..10
export const cid = (owner, colour, value) => owner * 40 + colour * 10 + (value - 1);
export const owner = (c) => (c / 40) | 0;
export const colour = (c) => ((c % 40) / 10) | 0;
export const value = (c) => (c % 10) + 1;
// Ready piles alternate "phase". amber/coral are warm (0), teal/indigo are cool (1).
export const phase = (c) => colour(c) % 2;

const top = (pile) => (pile.length ? pile[pile.length - 1] : null);

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function deckFor(seat) {
  const d = [];
  for (let col = 0; col < 4; col++) for (let v = 1; v <= 10; v++) d.push(cid(seat, col, v));
  return d;
}

/** Deal a fresh round. `seats` is the number of players. */
export function deal(seats, rand = Math.random) {
  const hands = [];
  for (let s = 0; s < seats; s++) {
    const d = shuffle(deckFor(s), rand);
    hands.push({
      race: d.slice(0, RACE_SIZE),
      ready: [[d[10]], [d[11]], [d[12]]],
      draw: d.slice(13), // 27 face down
      up: [], // face up, only the last is playable
      played: 0, // cards this seat has landed in the centre
    });
  }
  return { centre: [], hands, over: false, winner: null };
}

// ---- move validation -------------------------------------------------------

const canStack = (card, onto) =>
  onto !== null && value(card) === value(onto) - 1 && phase(card) !== phase(onto);

const canCentre = (card, pile) =>
  pile === null
    ? value(card) === 1
    : colour(card) === colour(top(pile)) && value(card) === value(top(pile)) + 1;

function takeSource(hand, from, pileIdx) {
  if (from === 'race') return top(hand.race) === null ? null : { card: top(hand.race), pop: () => hand.race.pop() };
  if (from === 'draw') return top(hand.up) === null ? null : { card: top(hand.up), pop: () => hand.up.pop() };
  if (from === 'ready') {
    const p = hand.ready[pileIdx];
    if (!p || !p.length) return null;
    return { card: top(p), pop: () => p.pop() };
  }
  return null;
}

// A ready pile that empties refills from the race pile immediately.
function refill(hand) {
  for (const p of hand.ready) {
    if (p.length === 0 && hand.race.length) p.push(hand.race.pop());
  }
}

/**
 * Apply a move for `seat`. Returns null if illegal, otherwise a small patch
 * describing what changed. Mutates `state` in place.
 */
export function applyMove(state, seat, move) {
  if (state.over) return null;
  const hand = state.hands[seat];
  if (!hand) return null;

  if (move.t === 'flip') {
    let recycled = false;
    if (hand.draw.length === 0) {
      if (hand.up.length === 0) return null; // draw pile is genuinely exhausted
      hand.draw = hand.up.reverse();
      hand.up = [];
      // Turning the stack over restores the original order exactly, so without
      // this rotation only every third card is ever reachable and a player with
      // no legal move can never unstick themselves. Shifting by one means all
      // 27 come up within three cycles.
      if (hand.draw.length > 1) hand.draw.unshift(hand.draw.pop());
      recycled = true;
    }
    const n = Math.min(3, hand.draw.length);
    for (let i = 0; i < n; i++) hand.up.push(hand.draw.pop());
    return { t: 'flip', seat, n, recycled };
  }

  if (move.t === 'ready') {
    // Only the race pile and the draw pile feed the ready piles.
    if (move.from !== 'race' && move.from !== 'draw') return null;
    const src = takeSource(hand, move.from);
    const dest = hand.ready[move.pile];
    if (!src || !dest || !canStack(src.card, top(dest))) return null;
    src.pop();
    dest.push(src.card);
    refill(hand);
    return { t: 'ready', seat, card: src.card, pile: move.pile };
  }

  if (move.t === 'centre') {
    const src = takeSource(hand, move.from, move.pile);
    if (!src) return null;
    const idx = move.target;
    const isNew = idx === -1 || idx === undefined || idx === null;
    const pile = isNew ? null : state.centre[idx];
    if (!isNew && !pile) return null;
    if (!canCentre(src.card, pile)) return null;
    src.pop();
    if (isNew) state.centre.push([src.card]);
    else pile.push(src.card);
    hand.played++;
    refill(hand);
    if (hand.race.length === 0) {
      state.over = true;
      state.winner = seat;
    }
    return { t: 'centre', seat, card: src.card, target: isNew ? state.centre.length - 1 : idx };
  }

  return null;
}

/** +1 per card you landed in the centre, -2 per card still in your race pile. */
export function scoreRound(state) {
  return state.hands.map((h) => h.played - 2 * h.race.length);
}

/**
 * The public view of the table. Everything here is legally visible to every
 * player, so it serialises ONCE and broadcasts to all 8 sockets. That single
 * choice is most of what keeps compute duration inside the free tier.
 */
export function publicView(state) {
  return {
    centre: state.centre.map((p) => [top(p), p.length]),
    hands: state.hands.map((h) => ({
      race: top(h.race),
      raceLeft: h.race.length,
      ready: h.ready.map((p) => [top(p), p.length]),
      up: top(h.up),
      upLeft: h.up.length,
      drawLeft: h.draw.length,
      played: h.played,
    })),
    over: state.over,
    winner: state.winner,
  };
}
