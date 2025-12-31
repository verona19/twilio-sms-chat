const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();

// --- Middleware ---
app.use(bodyParser.urlencoded({ extended: false })); // Twilio webhook form-encoded
app.use(express.json({ limit: "10mb" }));            // JSON for /send
app.use(express.static("public"));                   // <-- ВАЖЛИВО: віддає public/index.html

// --- In-memory storage (MVP) ---
const messages = [];

// --- Twilio client for sending ---
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- Webhook: incoming SMS/MMS from Twilio ---
app.post("/sms", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body || "";
  const numMedia = parseInt(req.body.NumMedia || "0", 10);

  const mediaUrls = [];
  for (let i = 0; i < numMedia; i++) {
    mediaUrls.push(req.body[`MediaUrl${i}`]);
  }

  messages.push({
    from,
    body,
    mediaUrls,
    direction: "inbound",
    at: new Date().toISOString(),
  });

  // Twilio expects TwiML response
  res.type("text/xml").send("<Response/>");
});

// --- API: list messages for UI ---
app.get("/messages", (req, res) => {
  res.json(messages);
});

// --- API: send message from UI ---
app.post("/send", async (req, res) => {
  try {
    const to = req.body.to;
    const body = req.body.body;

    if (!to || !body) return res.status(400).json({ error: "Missing to/body" });

    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body,
    });

    messages.push({
      from: to,
      body,
      mediaUrls: [],
      direction: "outbound",
      at: new Date().toISOString(),
    });

    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Make / open chat UI ---
app.get("/", (req, res) => {
  res.redirect("/index.html");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
