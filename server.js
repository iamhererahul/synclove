require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"], credentials: true },
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.get("/", (req, res) => res.send("SyncLove server is running ✓"));

// rooms = { roomId: { hostId, guestId, videoId } }
const rooms = new Map();

// gameRooms = { roomId: { hostId, players:[{id,name,color,isHost}], gameState, chat[] } }
const gameRooms = new Map();

const PLAYER_COLORS = ["#e8435a","#7b61ff","#00c9ff","#4caf50","#ffc107","#ff6b9d","#ff9800","#00bcd4"];

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  // ── WATCH ROOM (existing) ────────────────────────────────
  socket.on("create-room", ({ videoId }) => {
    const roomId = generateRoomId();
    rooms.set(roomId, { hostId: socket.id, guestId: null, videoId: videoId || "" });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "host";
    socket.emit("room-created", { roomId, videoId });
  });

  socket.on("host-rejoin", ({ roomId, videoId }) => {
    let room = rooms.get(roomId);
    if (!room) {
      rooms.set(roomId, { hostId: socket.id, guestId: null, videoId: videoId || "" });
      room = rooms.get(roomId);
    } else { room.hostId = socket.id; }
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "host";
    socket.emit("host-rejoined", { roomId, videoId: room.videoId });
  });

  socket.on("join-room", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit("join-error", { message: "Room not found. Make sure the host has the room open." }); return; }
    if (room.guestId && room.guestId !== socket.id) { socket.emit("join-error", { message: "Room is full. Only 2 users allowed." }); return; }
    room.guestId = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "guest";
    socket.emit("room-joined", { roomId, videoId: room.videoId });
    socket.to(roomId).emit("peer-joined", { message: "Your partner has connected!" });
  });

  socket.on("guest-rejoin", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit("join-error", { message: "Room expired." }); return; }
    room.guestId = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "guest";
    socket.emit("room-joined", { roomId, videoId: room.videoId });
    socket.to(roomId).emit("peer-joined", { message: "Your partner has reconnected!" });
  });

  socket.on("sync-play",  ({ roomId, time }) => socket.to(roomId).emit("sync-play",  { time }));
  socket.on("sync-pause", ({ roomId, time }) => socket.to(roomId).emit("sync-pause", { time }));
  socket.on("sync-seek",  ({ roomId, time }) => socket.to(roomId).emit("sync-seek",  { time }));

  socket.on("change-video", ({ roomId, videoId }) => {
    const room = rooms.get(roomId);
    if (room) room.videoId = videoId;
    socket.to(roomId).emit("change-video", { videoId });
  });

  socket.on("reaction",     ({ roomId, emoji })           => socket.to(roomId).emit("reaction",     { emoji }));
  socket.on("theme-change", ({ roomId, theme })           => socket.to(roomId).emit("theme-change", { theme }));
  socket.on("chat-message", ({ roomId, message, sender }) => socket.to(roomId).emit("chat-message", { message, sender }));

  // ── GAME ROOMS (new) ─────────────────────────────────────
  socket.on("game-create-room", ({ playerName }) => {
    const roomId = generateRoomId();
    const player = { id: socket.id, name: playerName || "Host", color: PLAYER_COLORS[0], isHost: true };
    gameRooms.set(roomId, { hostId: socket.id, players: [player], gameState: null, chat: [] });
    socket.join("game:" + roomId);
    socket.data.gameRoomId = roomId;
    socket.data.gameName = player.name;
    socket.emit("game-room-created", { roomId, player, players: [player] });
    console.log(`Game room created: ${roomId} by ${player.name}`);
  });

  socket.on("game-join-room", ({ roomId, playerName }) => {
    const room = gameRooms.get(roomId);
    if (!room) { socket.emit("game-join-error", { message: "Room not found. Check the Room ID." }); return; }
    if (room.players.length >= 8) { socket.emit("game-join-error", { message: "Room is full (max 8 players)." }); return; }
    const colorIdx = room.players.length % PLAYER_COLORS.length;
    const player = { id: socket.id, name: playerName || "Player", color: PLAYER_COLORS[colorIdx], isHost: false };
    room.players.push(player);
    socket.join("game:" + roomId);
    socket.data.gameRoomId = roomId;
    socket.data.gameName = player.name;
    socket.emit("game-joined", { roomId, player, players: room.players, gameState: room.gameState });
    io.to("game:" + roomId).emit("game-player-joined", { players: room.players, newPlayer: player });
    console.log(`${player.name} joined game room: ${roomId}`);
  });

  socket.on("game-rejoin", ({ roomId, playerName }) => {
    const room = gameRooms.get(roomId);
    if (!room) { socket.emit("game-join-error", { message: "Room expired. Ask host for a new room." }); return; }
    let existing = room.players.find(p => p.name === playerName);
    if (existing) {
      existing.id = socket.id;
      if (existing.isHost) room.hostId = socket.id;
    } else {
      const colorIdx = room.players.length % PLAYER_COLORS.length;
      existing = { id: socket.id, name: playerName || "Player", color: PLAYER_COLORS[colorIdx], isHost: false };
      room.players.push(existing);
    }
    socket.join("game:" + roomId);
    socket.data.gameRoomId = roomId;
    socket.data.gameName = playerName;
    socket.emit("game-rejoined", { roomId, player: existing, players: room.players, gameState: room.gameState });
    io.to("game:" + roomId).emit("game-player-joined", { players: room.players, newPlayer: existing });
  });

  socket.on("game-state-update", ({ roomId, gameState }) => {
    const room = gameRooms.get(roomId);
    if (!room) return;
    room.gameState = gameState;
    socket.to("game:" + roomId).emit("game-state-update", { gameState });
  });

  socket.on("game-action", ({ roomId, action, payload }) => {
    const room = gameRooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    io.to("game:" + roomId).emit("game-action", { action, payload, player });
  });

  socket.on("game-chat", ({ roomId, message }) => {
    const room = gameRooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    const msg = { playerName: player?.name || "?", color: player?.color || "#fff", message, ts: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    io.to("game:" + roomId).emit("game-chat", msg);
  });

  socket.on("game-reaction", ({ roomId, emoji }) => {
    const room = gameRooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    io.to("game:" + roomId).emit("game-reaction", { emoji, playerName: player?.name });
  });

  // ── DISCONNECT ──────────────────────────────────────────
  socket.on("disconnect", () => {
    const { roomId, role, gameRoomId, gameName } = socket.data;

    if (roomId) {
      socket.to(roomId).emit("peer-disconnected", { message: "Your partner disconnected." });
      const room = rooms.get(roomId);
      if (room) {
        if (role === "host") {
          setTimeout(() => { const r = rooms.get(roomId); if (r && r.hostId === socket.id) rooms.delete(roomId); }, 30000);
        } else { room.guestId = null; }
      }
    }

    if (gameRoomId) {
      const gRoom = gameRooms.get(gameRoomId);
      if (gRoom) {
        gRoom.players = gRoom.players.filter(p => p.id !== socket.id);
        io.to("game:" + gameRoomId).emit("game-player-left", { players: gRoom.players, playerName: gameName });
        if (gRoom.players.length === 0) {
          setTimeout(() => { const r = gameRooms.get(gameRoomId); if (r && r.players.length === 0) gameRooms.delete(gameRoomId); }, 60000);
        } else if (gRoom.hostId === socket.id) {
          gRoom.players[0].isHost = true;
          gRoom.hostId = gRoom.players[0].id;
          io.to("game:" + gameRoomId).emit("game-host-changed", { newHostId: gRoom.hostId, players: gRoom.players });
        }
      }
    }

    console.log(`Disconnected: ${socket.id}`);
  });
});

app.get("/rooms", (req, res) => {
  const list = {};
  rooms.forEach((v, k) => list[k] = { videoId: v.videoId, hasGuest: !!v.guestId });
  res.json(list);
});

app.get("/game-rooms", (req, res) => {
  const list = {};
  gameRooms.forEach((v, k) => list[k] = { players: v.players.length });
  res.json(list);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`SyncLove running on port ${PORT}`));
