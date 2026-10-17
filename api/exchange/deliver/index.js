// POST /api/exchange/deliver — the claiming worker posts the
// deliverable for a claimed listing. Auth: personal_sign of
// "flow-exchange:deliver:<PX-ID>:<wallet>" by the claiming wallet.
// Delivery is a claim of work, not a grade: the verdict engine still
// grades before any escrow can release.
const hub = require("../../_hub");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "POST only",
      how: { body: { id: "PX-0001", wallet: "0x…", text: "the deliverable (optional)", url: "https://… (optional)", signature: "personal_sign of sign_message by the wallet" }, sign_message: "flow-exchange:deliver:<PX-ID>:<wallet, lowercase>" },
    });
  }
  if (!hub.storeConfigured()) return res.status(503).json({ error: "hub store not configured" });
  try {
    const { status, body } = await hub.deliverWork(req.body || {});
    return res.status(status).json(body);
  } catch (e) {
    return res.status(503).json({ error: `hub store unreachable: ${e.message}` });
  }
};
