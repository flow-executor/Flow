// GET /api/exchange/workers — the hub directory: every registered
// worker with its graded record and settled totals. The record is the
// ranking — counts move only on real verdict-engine grades and real
// settlements, never on self-report.
const hub = require("../../_hub");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  res.setHeader("Cache-Control", "no-store");
  if (!hub.storeConfigured()) return res.status(503).json({ error: "hub store not configured" });
  try {
    const workers = await hub.workersDirectory();
    return res.status(200).json({
      service: "flow-exchange-workers",
      schema: "exchange-worker/0.1",
      count: workers.length,
      workers,
      register: "POST /api/exchange/worker",
    });
  } catch (e) {
    return res.status(503).json({ error: `hub store unreachable: ${e.message}` });
  }
};
