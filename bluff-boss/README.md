# BLUFF BOSS — Real-time multiplayer bluffing game

A responsive 2–8 player party game with room codes, secret submissions, voting, points, lives, elimination, reconnect support, and an eight-round game flow.

## Requirements

- Node.js 22 or newer
- npm

## Run locally

```bash
npm start
```

On Windows, double-click `start.bat` to launch the server in a terminal.

This build uses Node.js built-in HTTP and WebSocket support, sends WebSocket heartbeats, and has no third-party runtime dependencies. `npm install` is harmless but not required.

Open http://localhost:3000 in a browser. To test multiplayer locally, open two or more separate browser profiles or private windows and create/join a room. For devices on the same Wi-Fi, use the host computer's LAN IP address with port 3000 and allow the port through the firewall.

## Run the smoke test

With the server running in one terminal, run `npm run test:smoke` in another. It connects two real WebSocket clients, exercises room creation/join/readiness, checks answer privacy, plays all eight rounds, and verifies synchronized score/life state.

## Deploy publicly (Render)

This repository includes `render.yaml` for a Render Web Service.

1. Create a Git repository and push these files to GitHub.
2. In Render, choose **New → Blueprint** and select the repository. Or create a **Web Service** with build command `npm install` and start command `npm start`.
3. Use Node.js 22+. No application secrets are needed for the basic build.
4. Wait for deployment, then open the generated HTTPS URL.
5. Test room creation and joining from at least two separate devices. The service must support WebSocket upgrades on `/ws`.

The public URL is created by the hosting provider; it cannot be known before you deploy it.

## Game rules implemented

- 8 fixed rounds: known-answer fake facts/tricky questions plus two player-created truth-or-bluff story rounds.
- Players begin with 3 lives and 0 points.
- In fact/trick/final rounds, each active player submits a fake answer. The real answer is inserted anonymously, then each player votes for which answer they believe is true. Players cannot select their own submitted bluff. A correct vote earns +2; a wrong vote costs one life and the author of the selected fake earns +2.
- In story rounds, one rotating storyteller submits a story and privately marks it true or bluff. Other active players vote TRUE or BLUFF. A correct vote earns +2; a wrong vote costs a life and awards the storyteller +2.
- When only one player remains alive, or eight rounds finish, the game ends. The final winner is the highest-scoring player; ties use remaining lives, then successful-bluff points, then stable room ordering.
- The host controls start, next round, and rematch. A disconnected host role is passed to another connected player.
- Room state is in server memory. Rooms expire after three hours without activity. A process restart clears rooms, so this is intended as a first deployed game rather than a persistent-statistics service.

## Project structure

```text
bluff-boss/
  server.js            # Node HTTP + WebSocket authoritative game server
  public/
    index.html         # App shell
    style.css          # Responsive visual design
    client.js          # Browser UI and multiplayer events
  package.json
  render.yaml
  scripts/
    smoke-test.mjs   # Two-client, 8-round integration smoke test
  README.md
```

## Health check

`GET /health` returns a small JSON response used by hosting health checks.

## Known limitations for this initial build

- Room/game state is in memory, not a database; restarting or scaling to multiple independent server instances without sticky/session-aware shared state will end or split rooms.
- Player-created stories rely on the storyteller's honesty; the app cannot independently verify personal stories.
- Players reconnect with a browser-local session token. Clearing site storage removes that token.
- The current version includes 90-second phase timeouts to prevent a silent/disconnected player from blocking the room forever; a missing vote costs a life when voting times out.
