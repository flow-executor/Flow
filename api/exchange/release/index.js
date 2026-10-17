// POST /api/exchange/release — operator-only: settle a listing's held
// escrow after its grade passes. The settlement travels the same
// facilitator rail as every Flow payment; the listing is marked
// SETTLED only with the real settlement tx ref. Auth: x-exchange-key
// (the board operator key, same as every exchange action endpoint).
const hub = require("../../../_hub");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-exchange-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!hub.storeConfigured()) return res.status(503).json({ error: "hub store not configured" });
  try {
    const { status, body } = await hub.releaseEscrow(req, req.body || {});
    return res.status(status).json(body);
  } catch (e) {
    return res.status(503).json({ error: `hub store unreachable: ${e.message}` });
  }
};
