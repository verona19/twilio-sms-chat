// index.js (SQLite version)
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const path = require("path");
const fs = require("fs");

const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const app = express();

// --- Middleware
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json({ limit: "10mb" }));

// --- Static UI
app.use(express.static(path.join(__dirname, "public")));

// --- SQLite init
let db;

// You can override with env:
// - On Render with Persistent Disk: DB_PATH=/var/data/app.db
// - Locally: DB_PATH=./data/app.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "app.db");

async function initDb() {
  // Ensure folder exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  // Better concurrency behavior
  await db.exec("PRAGMA journal_mode = WAL;");
  await db.exec("PRAGMA foreign_keys = ON;");

  // Schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_phone TEXT NOT NULL,
      to_phone TEXT NOT NULL,
      body TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_from_phone ON messages(from_phone);
    CREATE INDEX IF NOT EXISTS idx_messages_to_phone   ON messages(to_phone);
    CREATE INDEX IF NOT EXISTS idx_messages_at         ON messages(at);
  `);
}

function normalizePhone(p) {
  return (p || "").toString().trim();
}

async function insertMessage(msg) {
  await db.run(
    `INSERT OR REPLACE INTO messages (id, from_phone, to_phone, body, direction, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    msg.id,
    msg.from,
    msg.to,
    msg.body,
    msg.direction,
    msg.at
  );
}

async function listContacts() {
  // "Other side" for inbound is from_phone, for outbound is to_phone.
  // We'll union them and sort.
  const rows = await db.all(`
    SELECT DISTINCT from_phone AS phone
    FROM messages
    WHERE direction='inbound'
    UNION
    SELECT DISTINCT to_phone AS phone
    FROM messages
    WHERE direction='outbound'
    ORDER BY phone ASC
  `);
  return rows.map((r) => r.phone);
}

async function getThread(phone) {
  const p = normalizePhone(phone);
  if (!p) return [];

  const rows = await db.all(
    `
    SELECT id,
           from_phone AS "from",
           to_phone   AS "to",
           body,
           direction,
           at
    FROM messages
    WHERE from_phone = ? OR to_phone = ?
    ORDER BY at ASC
    `,
    p,
    p
  );

  return rows;
}

// --- Health check
app.get("/health", (req, res) => res.json({ ok: true, db: DB_PATH }));

/**
 * TWILIO WEBHOOK: incoming SMS/MMS
 * URL: https://YOUR-RENDER-URL/sms
 * Method: POST
 */
app.post("/sms", async (req, res) => {
  try {
    const { From, To, Body } = req.body;

    await insertMessage({
      id: "in_" + Date.now() + "_" + Math.random().toString(16).slice(2),
      from: normalizePhone(From),
      to: normalizePhone(To),
      body: Body || "",
      direction: "inbound",
      at: new Date().toISOString(),
    });

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Got it ✅ You can continue texting here.");
    res.type("text/xml").send(twiml.toString());
  } catch (e) {
    // Twilio expects TwiML; if error, still respond gracefully
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Server error. Please try later.");
    res.type("text/xml").status(200).send(twiml.toString());
  }
});

// --- API: contacts list
app.get("/api/contacts", async (req, res) => {
  try {
    res.json({ contacts: await listContacts() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- API: messages (all or by phone thread)
app.get("/api/messages", async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) {
      // return last 200
      const rows = await db.all(`
        SELECT id,
               from_phone AS "from",
               to_phone   AS "to",
               body,
               direction,
               at
        FROM messages
        ORDER BY at DESC
        LIMIT 200
      `);
      return res.json({ messages: rows.reverse() });
    }

    res.json({ messages: await getThread(phone) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
      // Still save to DB as "outbound" draft? Usually no—better return error.
      return res.status(500).json({
        ok: false,
        error: "Missing env vars. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER",
      });
    }

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const sent = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body,
    });

    await insertMessage({
      id: sent.sid || "out_" + Date.now(),
      from: normalizePhone(TWILIO_PHONE_NUMBER),
      to,
      body,
      direction: "outbound",
      at: new Date().toISOString(),
    });

    res.json({ ok: true, sid: sent.sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Send failed" });
  }
});

// --- DEBUG: add fake inbound message (testing w/o phone) - remove later
app.get("/debug/add", async (req, res) => {
  try {
    const from = (req.query.from || "+10000000000").toString();
    const to = (req.query.to || process.env.TWILIO_PHONE_NUMBER || "+19999999999").toString();
    const body = (req.query.body || "Test inbound message").toString();

    await insertMessage({
      id: "dbg_" + Date.now(),
      from,
      to,
      body,
      direction: "inbound",
      at: new Date().toISOString(),
    });

    res.json({ ok: true, added: { from, to, body }, db: DB_PATH });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Fallback UI MUST BE LAST
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Start
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log("Server running on port", PORT, "DB:", DB_PATH));
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
