🎭 BLUFF BOSS — Real-Time Multiplayer Party Game

Live Demo: https://bluff-boss-project-1.onrender.com/

BLUFF BOSS is a browser-based bluffing game where friends can create a room, share a room code, and play together from their own phones or computers. No account or installation is required.

✨ Features

- Multiplayer rooms for 2–8 players
- Join rooms using a room code
- 8 rounds of bluffing challenges
- Secret answers and voting
- Live scores, lives, and player elimination
- Host-controlled game flow
- Responsive interface for desktop and mobile
- Real-time updates between connected players

🕹️ How to Play

1. Open the [Live Demo](https://bluff-boss-project-1.onrender.com/).
2. Enter a player name and create a room.
3. Share the room code with friends.
4. Friends open the same link and join using the code.
5. Play the rounds, spot bluffs, earn points, and try to become the **Bluff Boss**.

🛠️ Tech Stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js
- **Real-time multiplayer:** WebSockets
- **Hosting:** Render

📁 Project Structure

```text
bluff-boss-project/
├── README.md
└── bluff-boss/
    ├── public/
    │   ├── index.html
    │   ├── style.css
    │   └── client.js
    ├── scripts/
    │   └── smoke-test.mjs
    ├── .gitignore
    ├── .node-version
    ├── package.json
    ├── render.yaml
    ├── server.js
    └── start.bat
```

 💻 Run Locally

Requirements: Node.js 22–24 and npm.

```bash
cd bluff-boss
npm install
npm start
```

Open **http://localhost:3000** in your browser. Keep the terminal running while playing.

 🚀 Deployment

The game is deployed on Render:

https://bluff-boss-project-1.onrender.com/

The Render configuration is in `bluff-boss/render.yaml`. When deploying this repository, set the Render service's **Root Directory** to `bluff-boss`, then use:

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`

 🧪 Tests

Run the syntax checks from the `bluff-boss` folder:

```bash
npm run check
```

To run the multiplayer smoke test, start the app in one terminal:

```bash
npm start
```

Then run this in a second terminal:

```bash
npm run test:smoke
```

 📌 Notes

- Active room data is stored in server memory. A server restart or redeployment may clear active games.
- Players should use the live link above to join the same public game service.

---

Made for friends who trust no one. 🎭
