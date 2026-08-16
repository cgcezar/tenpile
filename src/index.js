import { Room } from './room.js';
import { Matchmaker, makeCode } from './matchmaker.js';

export { Room, Matchmaker };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const roomStub = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));
const matchStub = (env) => env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Quick play: hand back a room that already has people waiting in it.
    if (path === '/api/quickplay' && request.method === 'POST') {
      const { code } = await matchStub(env).open();
      await roomStub(env, code).describe(code);
      return json({ code });
    }

    // Custom room: a code you can text to seven friends.
    if (path === '/api/room' && request.method === 'POST') {
      const code = makeCode();
      await roomStub(env, code).describe(code);
      await matchStub(env).register(code);
      return json({ code });
    }

    if (path.startsWith('/api/room/')) {
      const code = path.slice('/api/room/'.length).toUpperCase();
      if (!/^[A-Z2-9]{4}$/.test(code)) return json({ error: 'Bad room code' }, 400);
      return json(await roomStub(env, code).describe(code));
    }

    if (path.startsWith('/ws/')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a websocket', { status: 426 });
      }
      const code = path.slice('/ws/'.length).toUpperCase();
      if (!/^[A-Z2-9]{4}$/.test(code)) return new Response('Bad room code', { status: 400 });
      return roomStub(env, code).fetch(request);
    }

    // Everything else is a static asset. These are free and unmetered.
    return env.ASSETS.fetch(request);
  },
};
