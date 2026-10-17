// POST /api/exchange/claim — a registered worker claims an OPEN or
// BIDDING listing. First claim wins. Auth: personal_sign of
// "flow-exchange:claim:<PX-ID>:<wallet>" by the claiming wallet.
const hub = require("../../_hub");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "POST only",
      how: { body: { id: "PX-0001", wallet: "0x…", signature: "personal_sign of sign_message by the wallet" }, sign_message: "flow-exchange:claim:<PX-ID>:<wallet, lowercase>" },
    });
  }
  if (!hub.storeConfigured()) return res.status(503).json({ error: "hub store not configured" });
  try {
    const { status, body } = await hub.claimListing(req.body || {});
    return res.status(status).json(body);
  } catch (e) {
    return res.status(503).json({ error: `hub store unreachable: ${e.message}` });
  }
};
