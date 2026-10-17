// POST /api/exchange/worker — register or update a hub worker profile.
// Auth: personal_sign of "flow-exchange:register:<wallet>" by the
// wallet itself (see api/_hub.js). GET ?id=<wallet> — one profile
// with its merged record (passport counts + hub claims + settled USD).
const hub = require("../../../_hub");

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
      const id = (u.searchParams.get("id") || "").trim();
      if (!id) {
        return res.status(200).json({
          service: "flow-exchange-worker",
          register: "POST {wallet, name, headline?, skills?[], solver_id?, signature} — signature is personal_sign of the message below by the wallet.",
          sign_message: "flow-exchange:register:<your wallet, lowercase>",
          directory: "GET /api/exchange/workers",
        });
      }
      const profile = await hub.workerProfile(id);
      if (!profile) return res.status(404).json({ error: `No hub worker ${id}`, code: "NO_WORKER" });
      return res.status(200).json({ schema: "exchange-worker/0.1", ...profile });
    }
    if (req.method === "POST") {
      const { status, body } = await hub.registerWorker(req.body || {});
      return res.status(status).json(body);
    }
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    return res.status(503).json({ error: `hub store unreachable: ${e.message}` });
  }
};
