# Tenpile

A simultaneous card race for 2–8 players, plus an offline scoresheet for when
you are playing with physical cards. Runs entirely on Cloudflare Workers +
Durable Objects, inside the free plan.

Rename it before you launch. `Tenpile` is a placeholder — pick your own name,
and keep the card artwork and rules wording your own.

## Layout

```
src/index.js       Worker: static assets, /api/quickplay, /api/room, /ws/:code
src/room.js        Room DO — one per game, holds up to 8 sockets
src/matchmaker.js  Matchmaker DO — the open-room list behind Quick play
public/engine.js   Pure rules. Imported by the server AND the browser.
public/game.html   The table
public/scoresheet.html  Offline scorekeeper, no network at all
public/rules.html  Rules and FAQ, precached for offline
public/sw.js       Service worker
```

Quick play does not poll rooms to ask whether they have space. Rooms push their
own closure to the matchmaker when they fill or start, so matchmaking costs one
request instead of one per open room.
