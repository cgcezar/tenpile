import { deal, applyMove, scoreRound, publicView, cid, value, colour, phase } from '../public/engine.js';
import assert from 'node:assert';

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// deal shape
const s = deal(8, rnd);
assert.equal(s.hands.length, 8);
for (const h of s.hands) {
  assert.equal(h.race.length, 10);
  assert.equal(h.draw.length, 27);
  assert.deepEqual(h.ready.map(p => p.length), [1,1,1]);
  assert.equal(new Set([...h.race, ...h.draw, ...h.ready.flat()]).size, 40);
}

// a 1 can open a centre pile; a 3 cannot
const t = deal(2, rnd);
t.hands[0].race[9] = cid(0, 1, 1);          // teal 1 on top
assert.ok(applyMove(t, 0, { t:'centre', from:'race', target:-1 }));
assert.equal(t.centre.length, 1);
assert.equal(t.hands[0].played, 1);

t.hands[0].race[8] = cid(0, 1, 3);
assert.equal(applyMove(t, 0, { t:'centre', from:'race', target:0 }), null, '3 must not follow 1');

// a 2 of the same colour does follow, from another player's deck
t.hands[1].race[9] = cid(1, 1, 2);
assert.ok(applyMove(t, 1, { t:'centre', from:'race', target:0 }), 'any deck feeds a centre pile');

// ready piles: descending, alternating phase
const r = deal(2, rnd);
r.hands[0].ready[0] = [cid(0, 0, 7)];       // amber 7, filled
r.hands[0].race[9] = cid(0, 1, 6);          // teal 6, hollow -> legal
assert.ok(applyMove(r, 0, { t:'ready', from:'race', pile:0 }));
r.hands[0].race[8] = cid(0, 3, 5);          // indigo 5, hollow -> same phase, illegal
assert.equal(applyMove(r, 0, { t:'ready', from:'race', pile:0 }), null);
r.hands[0].race[8] = cid(0, 2, 5);          // coral 5, filled -> legal
assert.ok(applyMove(r, 0, { t:'ready', from:'race', pile:0 }));

// an emptied ready pile refills from the race pile
const f = deal(2, rnd);
const before = f.hands[0].race.length;
f.hands[0].ready[0] = [cid(0, 1, 1)];
f.centre.push([cid(1, 1, 0 + 1)].slice(0,0));
f.centre[0] = [];
f.centre.length = 0;
assert.ok(applyMove(f, 0, { t:'centre', from:'ready', pile:0, target:-1 }));
assert.equal(f.hands[0].ready[0].length, 1, 'refilled');
assert.equal(f.hands[0].race.length, before - 1, 'refill came from the race pile');

// draw pile: three at a time, then recycle
const d = deal(2, rnd);
assert.ok(applyMove(d, 0, { t:'flip' }));
assert.equal(d.hands[0].up.length, 3);
assert.equal(d.hands[0].draw.length, 24);
while (d.hands[0].draw.length) applyMove(d, 0, { t:'flip' });
assert.equal(d.hands[0].up.length, 27);
// Recycling and flipping are ONE action, so the button never dead-ends.
const rec = applyMove(d, 0, { t:'flip' });
assert.equal(rec.recycled, true);
assert.equal(d.hands[0].draw.length, 24, 'recycled then immediately turned three');
assert.equal(d.hands[0].up.length, 3, 'three cards face up again');

// A single leftover card must still recycle rather than stranding the player.
const one = deal(2, rnd);
one.hands[0].draw = [];
one.hands[0].up = [cid(0, 0, 5)];
assert.ok(applyMove(one, 0, { t:'flip' }), 'one card still recycles');
assert.equal(one.hands[0].up.length, 1);

// Every draw card must become reachable, or a stuck player stays stuck.
const cyc = deal(2, rnd);
const seen = new Set();
for (let i = 0; i < 30; i++) { applyMove(cyc, 0, { t:'flip' }); if (cyc.hands[0].up.length) seen.add(cyc.hands[0].up.at(-1)); }
assert.equal(seen.size, 27, 'all 27 draw cards reachable within three cycles, got ' + seen.size);

// Only a genuinely exhausted draw pile refuses.
const none = deal(2, rnd);
none.hands[0].draw = []; none.hands[0].up = [];
assert.equal(applyMove(none, 0, { t:'flip' }), null, 'nothing to turn');

// scoring: +1 per card in the centre, -2 per card left
const e = deal(3, rnd);
e.hands[0].played = 22; e.hands[0].race = [];
e.hands[1].played = 14; e.hands[1].race = [1,2,3,4];
e.hands[2].played = 3;  e.hands[2].race = [1,2,3,4,5,6,7,8,9,10];
assert.deepEqual(scoreRound(e), [22, 6, -17]);

// emptying the race pile ends the round
const w = deal(2, rnd);
w.hands[1].race = [cid(1, 0, 1)];
w.hands[1].ready = [[cid(1,0,9)],[cid(1,1,9)],[cid(1,2,9)]];
applyMove(w, 1, { t:'centre', from:'race', target:-1 });
assert.equal(w.over, true);
assert.equal(w.winner, 1);
assert.equal(applyMove(w, 0, { t:'flip' }), null, 'no moves after the round ends');

// the public view is one object for everyone and leaks no hidden order
const v = publicView(deal(8, rnd));
assert.equal(v.hands.length, 8);
assert.ok(!JSON.stringify(v).includes('draw"'), 'face-down order is not shipped');
assert.ok(JSON.stringify(v).length < 3000, 'broadcast payload stays small: ' + JSON.stringify(v).length);

console.log('all engine tests passed');
console.log('8-player broadcast payload:', JSON.stringify(v).length, 'bytes');
