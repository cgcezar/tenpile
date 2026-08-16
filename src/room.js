import { DurableObject } from 'cloudflare:workers';
import { deal, applyMove, scoreRound, publicView, MAX_SEATS, DEFAULT_TARGET } from '../public/engine.js';

// Cheap per-socket token bucket. Without this, one bad client with a while(true)
// loop can burn the whole daily request allowance in a couple of minutes.
const RATE_BURST = 40;
const RATE_PER_SEC = 20;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Persisted: roster, scores, round number. Survives hibernation.
    this.meta = null;
    // In memory only: the live round. Deliberately NOT written per move.
    this.game = null;
    this.buckets = new Map();

    // Heartbeats never wake the object or bill duration.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('p', 'q'));
  }

  async load() {
    if (!this.meta) {
      this.meta = (await this.ctx.storage.get('meta')) ?? {
        code: null,
        players: [], // { pid, name, seat, total }
        round: 0,
        target: DEFAULT_TARGET,
        phase: 'lobby', // lobby | playing | roundEnd | gameOver
        started: false,
      };
    }
    return this.meta;
  }

  // --- called over RPC from the Worker ---------------------------------------

  async describe(code) {
    const m = await this.load();
    if (!m.code) {
      m.code = code;
      await this.save();
    }
    return {
      code: m.code,
      players: m.players.length,
      seats: MAX_SEATS,
      phase: m.phase,
      joinable: m.players.length < MAX_SEATS && !m.started,
    };
  }

  async save() {
    // One row written per call. Called at round boundaries and roster changes,
    // never on a card play.
    await this.ctx.storage.put('meta', this.meta);
  }

  // --- websockets ------------------------------------------------------------

  async fetch(request) {
    const m = await this.load();
    const url = new URL(request.url);
    const name = (url.searchParams.get('name') || 'Player').slice(0, 16);
    const pid = url.searchParams.get('pid') || crypto.randomUUID();

    let player = m.players.find((p) => p.pid === pid);
    if (!player) {
      if (m.players.length >= MAX_SEATS) return new Response('Room is full', { status: 409 });
      if (m.started) return new Response('Round already in progress', { status: 409 });
      player = { pid, name, seat: m.players.length, total: 0 };
      m.players.push(player);
      await this.save();
      if (m.players.length >= MAX_SEATS) await this.closeToMatchmaking();
    } else {
      player.name = name;
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // acceptWebSocket, NOT server.accept(). This is the whole ballgame for
    // billing: accept() bills wall-clock for as long as the socket is open.
    this.ctx.acceptWebSocket(server);
    // Survives eviction, so we can identify the player without touching storage.
    server.serializeAttachment({ pid: player.pid, seat: player.seat });
    // The client must never infer its own seat from the name: two people can
    // pick the same one, and seats shift when somebody leaves the lobby.
    server.send(JSON.stringify({ t: 'you', seat: player.seat, pid: player.pid }));

    this.resync();
    this.broadcast({ t: 'roster', ...this.roster() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    if (!this.allow(att.pid)) return ws.send('{"t":"slowdown"}');

    const m = await this.load();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === 'start') {
      if (m.players.length < 2) return ws.send('{"t":"error","m":"Needs at least 2 players"}');
      return this.startRound();
    }

    if (msg.t === 'move') {
      // Evicted mid-round: the live piles are gone. Say so plainly rather than
      // pretending. Scores are safe because they were persisted at round end.
      if (!this.game) {
        if (m.phase === 'playing') {
          m.phase = 'lobby';
          m.started = false;
          await this.save();
          this.broadcast({ t: 'aborted', ...this.roster() });
        }
        return;
      }
      const patch = applyMove(this.game, att.seat, msg.move);
      if (!patch) return ws.send('{"t":"reject","seq":' + (msg.seq | 0) + '}');
      if (this.game.over) return this.endRound();
      // One serialisation, eight recipients. Outgoing messages are free.
      return this.broadcast({ t: 'state', v: publicView(this.game) });
    }
  }

  async webSocketClose(ws) {
    const m = await this.load();
    // In the lobby, a leaver frees the seat. Mid-round they keep it and can rejoin.
    const att = ws.deserializeAttachment();
    if (att && m.phase === 'lobby') {
      m.players = m.players.filter((p) => p.pid !== att.pid);
      m.players.forEach((p, i) => (p.seat = i));
      await this.save();
      this.resync();
    }
    this.broadcast({ t: 'roster', ...this.roster() });
  }

  webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch {}
  }

  // --- round lifecycle -------------------------------------------------------

  async startRound() {
    const m = await this.load();
    this.game = deal(m.players.length);
    m.phase = 'playing';
    m.started = true;
    m.round++;
    await this.save();
    await this.closeToMatchmaking();
    this.broadcast({
      t: 'begin',
      round: m.round,
      seats: m.players.map((p) => ({ name: p.name, total: p.total })),
      v: publicView(this.game),
    });
  }

  async endRound() {
    const m = await this.load();
    const deltas = scoreRound(this.game);
    m.players.forEach((p, i) => (p.total += deltas[i] ?? 0));
    const done = m.players.some((p) => p.total >= m.target);
    m.phase = done ? 'gameOver' : 'roundEnd';
    m.started = false;
    await this.save(); // the one write per round
    const final = publicView(this.game);
    this.game = null; // let it hibernate between rounds
    this.broadcast({
      t: 'roundEnd',
      winner: final.winner,
      deltas,
      totals: m.players.map((p) => p.total),
      gameOver: done,
      target: m.target,
      v: final,
    });
  }

  // --- helpers ---------------------------------------------------------------

  roster() {
    const m = this.meta;
    return {
      players: m.players.map((p) => ({ name: p.name, seat: p.seat, total: p.total })),
      phase: m.phase,
      round: m.round,
      target: m.target,
      code: m.code,
    };
  }

  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch {}
    }
  }

  // Seats are reindexed when somebody leaves the lobby, so every socket needs
  // its attachment rewritten and its own seat re-sent.
  resync() {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att) continue;
      const p = this.meta.players.find((x) => x.pid === att.pid);
      if (!p) continue;
      ws.serializeAttachment({ pid: p.pid, seat: p.seat });
      try { ws.send(JSON.stringify({ t: 'you', seat: p.seat, pid: p.pid })); } catch {}
    }
  }

  async closeToMatchmaking() {
    const m = this.meta;
    if (!m.code || m.closedToMatching) return;
    m.closedToMatching = true;
    try {
      const id = this.env.MATCHMAKER.idFromName('global');
      await this.env.MATCHMAKER.get(id).close(m.code);
    } catch {}
  }

  allow(pid) {
    const now = Date.now();
    let b = this.buckets.get(pid);
    if (!b) { b = { tokens: RATE_BURST, at: now }; this.buckets.set(pid, b); }
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 1000) * RATE_PER_SEC);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }
}
