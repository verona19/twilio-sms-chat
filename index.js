/**
 * twilio-sms-chat (MVP)
 * Routes:
 *  - GET  /            -> redirect to /index.html
 *  - POST /sms         -> Twilio incoming SMS/MMS webhook
 *  - GET  /messages    -> UI fetch all stored messages (RAM)
 *  - POST /send        -> UI sends SMS/MMS via Twilio
 *
 * Env vars required on Render:
 *  - TWILIO_ACCOUNT_SID
 *  - TWILIO_AUTH_TOKEN
 *  - TWILIO_PHONE_NUMBER   (your Twilio number, e.g. +1...)
 * Optional (recommended):
 *  - TWILIO_WEBHOOK_SECRET  (leave empty to skip signature validation)
 */

const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();

// -------------------- Middleware --------------------
// Twilio sends x-www-form-urlencoded by default
app.use(bodyParser.urlencoded({ extended: false }));
// UI uses JSON for /send
app.use(express.json({ limit: "10mb" }));

// Serve static UI from /public
app.use(express.static("public"));

// -------------------- In-memory storage (MVP) --------------------
/**
 * message shape:
 * {
 *   id: string,
 *   from: string,        // peer phone number (contact)
 *   body: string,
 *   direction: "inbound" | "outbound",
 *   at: string ISO date,
 *   mediaUrls: string[]
 * }
 */
const messages = [];

// -------------------- Twilio client --------------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  TWILIO_WEBHOOK_SECRET, // optional
} = process.env;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// -------------------- Helpers --------------------
function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function extractMediaUrlsFromTwilio(reqBody) {
  const numMedia = parseInt(reqBody.NumMedia || "0", 10);
  const urls = [];
  for (let i = 0; i < numMedia; i++) {
    const u = reqBody[`MediaUrl${i}`];
    if (u) urls.push(u);
  }
  return urls;
}

function validateTwilioSignature(req, res) {
  // If you don't set secret, we skip validation (still works)
  if (!TWILIO_WEBHOOK_SECRET) return true;

  try {
    const signature = req.header("X-Twilio-Signature");
    if (!signature) return false;

    const protocol = req.header("x-forwarded-proto") || req.protocol;
    const host = req.header("x-forwarded-host") || req.get("host");
    const url = `${protocol}://${host}${req.originalUrl}`;

    const ok = twilio.validateRequest(
      TWILIO_WEBHOOK_SECRET,
      signature,
      url,
      req.body
    );
    return ok;
  } catch (e) {
    return false;
  }
}

// -------------------- Routes --------------------

// Make / open chat UI
app.get("/", (req, res) => {
  res.redirect("/index.html");
});

// For UI
app.get("/messages", (req, res) => {
  // Optional: return newest first if you want
  res.json(messages);
});

// Twilio incoming SMS/MMS webhook
app.post("/sms", (req, res) => {
  // Security (optional): validate signature
  if (!validateTwilioSignature(req, res)) {
    return res.status(403).send("Forbidden (invalid Twilio signature)");
  }

  const from = req.body.From; // sender phone
  const body = req.body.Body || "";
  const mediaUrls = extractMediaUrlsFromTwilio(req.body);

  messages.push({
    id: uid(),
    from,
    body,
    direction: "inbound",
    at: new Date().toISOString(),
    mediaUrls,
  });

  // You can reply or return empty <Response/>
  // If you reply, user will get auto message every time they text you.
  // For now: no auto-reply (better for real chat)
  res.type("text/xml").send("<Response/>");
});

// UI -> send SMS/MMS
app.post("/send", async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(500).json({
        error:
          "Twilio client not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
      });
    }
    if (!TWILIO_PHONE_NUMBER) {
      return res.status(500).json({
        error: "Missing TWILIO_PHONE_NUMBER env var.",
      });
    }

    const to = (req.body.to || "").trim();
    const text = (req.body.text || req.body.body || "").trim(); // support both keys
    const mediaUrl = (req.body.mediaUrl || "").trim(); // optional for MMS

    if (!to) return res.status(400).json({ error: "Missing 'to'." });
    if (!text && !mediaUrl)
      return res.status(400).json({ error: "Provide 'text' or 'mediaUrl'." });

    const payload = {
      from: TWILIO_PHONE_NUMBER,
      to,
    };

    if (text) payload.body = text;
    if (mediaUrl) payload.mediaUrl = [mediaUrl];

    await twilioClient.messages.create(payload);

    messages.push({
      id: uid(),
      from: to,
      body: text || "(MMS)",
      direction: "outbound",
      at: new Date().toISOString(),
      mediaUrls: mediaUrl ? [mediaUrl] : [],
    });

    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check (optional)
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Serving static from:", path.join(__dirname, "public"));
  console.log(`Server running on port ${PORT}`);
});
