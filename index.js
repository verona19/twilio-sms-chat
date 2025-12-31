require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ===== SQLITE (persistent disk) =====
const DB_PATH = process.env.DB_PATH || "/var/data/app.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_phone TEXT NOT NULL,
      to_phone TEXT NOT NULL,
      body TEXT NOT NULL,
      direction TEXT NOT NULL,
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

// ===== HEALTH =====
app.get("/health", (req, res) => {
  res.json({ ok: true, db: DB_PATH });
});

// ===== INBOUND (Twilio webhook) =====
app.post("/sms", (req, res) => {
  const { From, To, Body } = req.body;

  const msg = {
    id: "in_" + Date.now() + "_" + Math.random().toString(16).slice(2),
    from: normalizePhone(From),
    to: normalizePhone(To),
    body: (Body || "").toString(),
    direction: "inbound",
    at: new Date().toISOString(),
  };

  db.run(
    `INSERT OR REPLACE INTO messages (id, from_phone, to_phone, body, direction, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.from, msg.to, msg.body, msg.direction, msg.at],
    () => {}
  );

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("Got it ✅ You can continue texting here.");
  res.type("text/xml").send(twiml.toString());
});

// ===== CONTACTS =====
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

// ===== MESSAGES =====
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

// ===== SEND =====
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

    const msg = {
      id: sent.sid || "out_" + Date.now(),
      from: normalizePhone(TWILIO_PHONE_NUMBER),
      to,
      body,
      direction: "outbound",
      at: new Date().toISOString(),
    };

    db.run(
      `INSERT OR REPLACE INTO messages (id, from_phone, to_phone, body, direction, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [msg.id, msg.from, msg.to, msg.body, msg.direction, msg.at],
      (err) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({ ok: true, sid: sent.sid });
      }
    );
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Send failed" });
  }
});

// ===== DEBUG (remove later) =====
app.get("/debug/add", (req, res) => {
  const from = normalizePhone(req.query.from || "+380000000000");
  const to = normalizePhone(process.env.TWILIO_PHONE_NUMBER || "+19999999999");
  const body = (req.query.body || "Test").toString();

  const msg = {
    id: "dbg_" + Date.now(),
    from,
    to,
    body,
    direction: "inbound",
    at: new Date().toISOString(),
  };

  db.run(
    `INSERT OR REPLACE INTO messages (id, from_phone, to_phone, body, direction, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.from, msg.to, msg.body, msg.direction, msg.at],
    (err) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true });
    }
  );
});

// ===== UI fallback MUST be last =====
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT, "DB:", DB_PATH));
