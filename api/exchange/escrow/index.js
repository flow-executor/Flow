// POST /api/exchange/escrow — the poster locks a listing's budget to
// the claimed worker as a signed EIP-3009 authorization, held
// UNSETTLED. The signature is the lock: it can only ever pay that
// worker that amount. GET ?id=PX-0001 — public escrow status (the
// signature itself is never exposed).
const hub = require("../../_hub");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Cache-Control", "no-store");
  if (!hub.storeConfigured()) return res.status(503).json({ error: "hub store not configured" });
  try {
    if (req.method === "GET") {
      const u = new URL(req.url, "https://flow-kg4x.vercel.app");
      const id = (u.searchParams.get("id") || "").toUpperCase();
      if (!/^PX-\d{4}$/.test(id)) return res.status(400).json({ error: "Provide ?id=PX-0001" });
      const escrow = await hub.getEscrow(id);
      if (!escrow) return res.status(404).json({ error: `No escrow on ${id}`, code: "NO_ESCROW" });
      return res.status(200).json({ schema: "exchange-escrow/0.1", ...escrow });
    }
    if (req.method === "POST") {
      const { status, body } = await hub.depositEscrow(req.body || {});
      return res.status(status).json(body);
    }
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    return res.status(503).json({ error: `hub store unreachable: ${e.message}` });
  }
};
