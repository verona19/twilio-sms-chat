const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();

// Для Twilio webhook (SMS/MMS)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json({ limit: "10mb" }));

// Webhook: вхідні SMS / MMS
app.post("/sms", (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  // Можеш змінити текст відповіді пізніше
  twiml.message("Got it ✅ You can continue texting here.");

  res.type("text/xml").send(twiml.toString());
});

// Health check
app.get("/", (req, res) => {
  res.send("Twilio SMS/MMS chat server is running ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
