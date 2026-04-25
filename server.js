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

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on("connection", (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ── CREATE ROOM (from lobby) ────────────────
  socket.on("create-room", ({ videoId }) => {
    const roomId = generateRoomId();
    rooms.set(roomId, { hostId: socket.id, guestId: null, videoId: videoId || "" });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "host";
    socket.emit("room-created", { roomId, videoId });
    console.log(`🏠 Room created: ${roomId}`);
  });

  // ── HOST REJOIN (room page reconnect) ───────
  socket.on("host-rejoin", ({ roomId, videoId }) => {
    let room = rooms.get(roomId);
    if (!room) {
      // Room was lost (server restart etc) — recreate it
      rooms.set(roomId, { hostId: socket.id, guestId: null, videoId: videoId || "" });
      room = rooms.get(roomId);
      console.log(`🔄 Room recreated by host: ${roomId}`);
    } else {
      room.hostId = socket.id;
    }
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "host";
    socket.emit("host-rejoined", { roomId, videoId: room.videoId });
  });

  // ── GUEST JOIN (from lobby) ─────────────────
  socket.on("join-room", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("join-error", { message: "Room not found. Make sure the host has the room open." });
      return;
    }
    if (room.guestId && room.guestId !== socket.id) {
      socket.emit("join-error", { message: "Room is full. Only 2 users allowed." });
      return;
    }
    room.guestId = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "guest";
    socket.emit("room-joined", { roomId, videoId: room.videoId });
    socket.to(roomId).emit("peer-joined", { message: "Your partner has connected!" });
    console.log(`👥 Guest joined: ${roomId}`);
  });

  // ── GUEST REJOIN (room page reconnect) ──────
  socket.on("guest-rejoin", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("join-error", { message: "Room expired. Please ask the host to share a new room ID." });
      return;
    }
    room.guestId = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "guest";
    socket.emit("room-joined", { roomId, videoId: room.videoId });
    socket.to(roomId).emit("peer-joined", { message: "Your partner has reconnected!" });
  });

  // ── SYNC EVENTS ─────────────────────────────
  socket.on("sync-play",  ({ roomId, time }) => socket.to(roomId).emit("sync-play",  { time }));
  socket.on("sync-pause", ({ roomId, time }) => socket.to(roomId).emit("sync-pause", { time }));
  socket.on("sync-seek",  ({ roomId, time }) => socket.to(roomId).emit("sync-seek",  { time }));

  // ── CHANGE VIDEO ────────────────────────────
  socket.on("change-video", ({ roomId, videoId }) => {
    const room = rooms.get(roomId);
    if (room) room.videoId = videoId;
    socket.to(roomId).emit("change-video", { videoId });
  });

  // ── GAME EVENTS (relay to room partner) ─────
  socket.on("game-event", ({ roomId, type, data }) => {
    socket.to(roomId).emit("game-event", { type, data });
  });

  // ── REACTIONS ────────────────────────────────
  socket.on("reaction", ({ roomId, emoji }) => {
    socket.to(roomId).emit("reaction", { emoji });
  });

  // ── THEME CHANGE ─────────────────────────────
  socket.on("theme-change", ({ roomId, theme }) => {
    socket.to(roomId).emit("theme-change", { theme });
  });

  // ── CHAT ────────────────────────────────────
  socket.on("chat-message", ({ roomId, message, sender }) => {
    socket.to(roomId).emit("chat-message", { message, sender });
  });

  // ── DISCONNECT ──────────────────────────────
  socket.on("disconnect", () => {
    const { roomId, role } = socket.data;
    if (!roomId) return;
    socket.to(roomId).emit("peer-disconnected", { message: "Your partner disconnected." });
    const room = rooms.get(roomId);
    if (!room) return;
    if (role === "host") {
      // Give host 30s to rejoin before deleting room
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.hostId === socket.id) {
          rooms.delete(roomId);
          console.log(`🗑 Room deleted: ${roomId}`);
        }
      }, 30000);
    } else {
      room.guestId = null;
    }
    console.log(`❌ Disconnected: ${socket.id} (${role})`);
  });
});

// Debug: list active rooms
app.get("/rooms", (req, res) => {
  const list = {};
  rooms.forEach((v, k) => list[k] = { videoId: v.videoId, hasGuest: !!v.guestId });
  res.json(list);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 SyncLove running on port ${PORT}`));
