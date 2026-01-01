// index.js (SQLite3-only + SAFE fallback for /var/data)
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const path = require("path");
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3").verbose();

const app = express();

// --- Middleware
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json({ limit: "10mb" }));

// --- Static UI
app.use(express.static(path.join(__dirname, "public")));

// =======================
// SQLITE (safe persistence)
// =======================
const DESIRED_DB_PATH = process.env.DB_PATH || "/var/data/app.db";

// Pick a final DB path:
// - If /var/data exists and is writable → use it (persistent on Starter + Disk)
// - Otherwise fallback to OS temp dir (works on Free, but NOT persistent)
let DB_PATH = DESIRED_DB_PATH;

function canWriteDir(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

try {
  if (DB_PATH.startsWith("/var/data/")) {
    // Do NOT mkdir /var/data. It must be mounted by Render Disk.
    if (!canWriteDir("/var/data")) {
      DB_PATH = path.join(os.tmpdir(), "app.db");
    }
  } else {
    // For other paths we can create the folder
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
} catch (e) {
  DB_PATH = path.join(os.tmpdir(), "app.db");
}

// Open DB
const db = new sqlite3.Database(DB_PATH);

// Init schema
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_phone TEXT NOT NULL,
      to_phone TEXT NOT NULL,
      body TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      at TEXT NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_phone)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_phone)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_at ON messages(at)`);
});

function normalizePhone(p) {
  return (p || "").toString().trim();
}

function insertMessage({ id, from, to, body, direction, at }, cb) {
  db.run(
    `INSERT OR REPLACE INTO messages (id, from_phone, to_phone, body, direction, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, from, to, body, direction, at],
    cb || (() => {})
  );
}

// --- Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    db: DB_PATH,
    desiredDb: DESIRED_DB_PATH,
    persistentEnabled: DB_PATH.startsWith("/var/data/"),
  });
});

/**
 * TWILIO WEBHOOK: incoming SMS/MMS
 * Set Twilio webhook to: https://YOUR-RENDER-URL/sms (POST)
 */
app.post("/sms", (req, res) => {
  const { From, To, Body } = req.body;

  insertMessage({
    id: "in_" + Date.now() + "_" + Math.random().toString(16).slice(2),
    from: normalizePhone(From),
    to: normalizePhone(To),
    body: (Body || "").toString(),
    direction: "inbound",
    at: new Date().toISOString(),
  });

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("Got it ✅ You can continue texting here.");
  res.type("text/xml").send(twiml.toString());
});

// --- API: contacts
app.get("/api/contacts", (req, res) => {
  db.all(
    `
    SELECT DISTINCT from_phone AS phone
    FROM messages
    WHERE direction='inbound'
    UNION
    SELECT DISTINCT to_phone AS phone
    FROM messages
    WHERE direction='outbound'
    ORDER BY phone ASC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ contacts: rows.map((r) => r.phone) });
    }
  );
});

// --- API: messages thread
app.get("/api/messages", (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.json({ messages: [] });

  db.all(
    `
    SELECT
      id,
      from_phone AS "from",
      to_phone   AS "to",
      body,
      direction,
      at
    FROM messages
    WHERE from_phone=? OR to_phone=?
    ORDER BY at ASC
    `,
    [phone, phone],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ messages: rows });
    }
  );
});

// --- API: send outbound SMS from UI
app.post("/api/send", async (req, res) => {
  try {
    const to = normalizePhone(req.body.to);
    const body = (req.body.body || "").toString();

    if (!to) return res.status(400).json({ ok: false, error: "Missing 'to'" });
    if (!body) return res.status(400).json({ ok: false, error: "Missing 'body'" });

    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER",
      });
    }

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const sent = await client.messages.create({ from: TWILIO_PHONE_NUMBER, to, body });

    insertMessage(
      {
        id: sent.sid || "out_" + Date.now(),
        from: normalizePhone(TWILIO_PHONE_NUMBER),
        to,
        body,
        direction: "outbound",
        at: new Date().toISOString(),
      },
      (err) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({ ok: true, sid: sent.sid });
      }
    );
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Send failed" });
  }
});

// --- DEBUG: add fake inbound message (testing w/o phone)
app.get("/debug/add", (req, res) => {
  const from = normalizePhone(req.query.from || "+380000000000");
  const to = normalizePhone(req.query.to || process.env.TWILIO_PHONE_NUMBER || "+19999999999");
  const body = (req.query.body || "Test inbound message").toString();

  insertMessage(
    {
      id: "dbg_" + Date.now(),
      from,
      to,
      body,
      direction: "inbound",
      at: new Date().toISOString(),
    },
    (err) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, db: DB_PATH });
    }
  );
});

// --- UI fallback (must be last)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT, "DB:", DB_PATH));
