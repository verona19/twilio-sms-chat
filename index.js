const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const path = require("path");

const app = express();

// ================== CONFIG ==================
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ================== STORAGE (in-memory) ==================
const messages = []; 
// { from, to, body, direction, date }

// ================== MIDDLEWARE ==================
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ================== ROUTES ==================

// Health check
app.get("/", (req, res) => {
  res.send("Twilio SMS/MMS chat server is running ✅");
});

// ---- Incoming SMS from Twilio ----
app.post("/sms", (req, res) => {
  const { From, To, Body } = req.body;

  messages.push({
    from: From,
    to: To,
    body: Body,
    direction: "inbound",
    date: new Date()
  });

  console.log("📩 INBOUND SMS:", From, Body);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("Got it ✅ You can continue texting here.");

  res.type("text/xml").send(twiml.toString());
});

// ---- Get all messages for UI ----
app.get("/messages", (req, res) => {
  res.json(messages);
});

// ---- Send SMS from Web UI ----
app.post("/send", async (req, res) => {
  const { to, body } = req.body;

  try {
    const msg = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      body
    });

    messages.push({
      from: TWILIO_PHONE_NUMBER,
      to,
      body,
      direction: "outbound",
      date: new Date()
    });

    console.log("📤 OUTBOUND SMS:", to, body);

    res.json({ success: true, sid: msg.sid });
  } catch (err) {
    console.error("❌ SEND ERROR:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
