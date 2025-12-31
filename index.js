// index.js
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const path = require("path");

const app = express();

// --- Middleware
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends form-encoded by default
app.use(express.json({ limit: "10mb" }));

// --- In-memory storage (variant 1)
const store = {
  messages: [], // [{ id, from, to, body, direction, at }]
};

function normalizePhone(p) {
  return (p || "").toString().trim();
}

function upsertMessage(msg) {
  store.messages.push(msg);
  // keep memory bounded
  if (store.messages.length > 2000) store.messages.shift();
}

function listContacts() {
  const set = new Set();
  for (const m of store.messages) {
    const other =
      m.direction === "inbound"
        ? normalizePhone(m.from)
        : normalizePhone(m.to);
    if (other) set.add(other);
  }
  return Array.from(set).sort();
}

function getThread(phone) {
  const p = normalizePhone(phone);
  if (!p) return [];
  return store.messages
    .filter((m) => normalizePhone(m.from) === p || normalizePhone(m.to) === p)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

// --- Serve static UI
app.use(express.static(path.join(__dirname, "public")));

// --- Health check
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * TWILIO WEBHOOK: incoming SMS/MMS
 * Twilio -> Phone Number (or Messaging Service) -> "A message comes in"
 * URL: https://YOUR-RENDER-URL/sms
 * Method: POST
 */
app.post("/sms", (req, res) => {
  const { From, To, Body } = req.body;

  // Save inbound message
  upsertMessage({
    id: "in_" + Date.now() + "_" + Math.random().toString(16).slice(2),
    from: normalizePhone(From),
    to: normalizePhone(To),
    body: Body || "",
    direction: "inbound",
    at: new Date().toISOString(),
  });

  // Reply back (simple)
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("Got it ✅ You can continue texting here.");

  res.type("text/xml").send(twiml.toString());
});

// --- API: contacts list
app.get("/api/contacts", (req, res) => {
  res.json({ contacts: listContacts() });
});

// --- API: messages (all or by phone thread)
app.get("/api/messages", (req, res) => {
  const phone = req.query.phone;
  if (phone) return res.json({ messages: getThread(phone) });

  // last 200 messages
  res.json({ messages: store.messages.slice(-200) });
});

// --- API: send outbound SMS from UI
app.post("/api/send", async (req, res) => {
  try {
    const to = normalizePhone(req.body.to);
    const body = (req.body.body || "").toString();

    if (!to) return res.status(400).json({ ok: false, error: "Missing 'to'" });
    if (!body) return res.status(400).json({ ok: false, error: "Missing 'body'" });

    const {
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_PHONE_NUMBER,
    } = process.env;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
      return res.status(500).json({
        ok: false,
        error:
          "Missing env vars. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER",
      });
    }

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const sent = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body,
    });

    // Save outbound message
    upsertMessage({
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

// --- DEBUG: add fake inbound message (for testing without phone)
// Remove later.
app.get("/debug/add", (req, res) => {
  const from = (req.query.from || "+10000000000").toString();
  const to = (req.query.to || process.env.TWILIO_PHONE_NUMBER || "+19999999999").toString();
  const body = (req.query.body || "Test inbound message").toString();

  upsertMessage({
    id: "dbg_" + Date.now(),
    from,
    to,
    body,
    direction: "inbound",
    at: new Date().toISOString(),
  });

  res.json({ ok: true, added: { from, to, body }, total: store.messages.length });
});

// --- Fallback to UI (single page) MUST BE LAST
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
