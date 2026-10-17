// Problem Exchange — HUB layer (worker profiles, claims, deliveries,
// authorization-held escrow). Companion to api/_exchange.js: the
// curated board state (px:*) stays operator-written; everything here
// lives in the pxh:* namespace and is written by the participants
// themselves, authenticated by wallet signature (EIP-191 for actions,
// EIP-712/EIP-3009 for the escrow authorization).
//
// The money doctrine is unchanged (Path C): Flow never holds funds.
// An escrow is a signed EIP-3009 authorization the POSTER signs to the
// WORKER's wallet, stored unsettled. It can only ever pay that worker
// that exact amount — the signature itself is the lock. On GRADED_PASS
// the operator settles it through the same facilitator path the paid
// endpoints use, and the listing is marked SETTLED only with the real
// settlement tx ref (the board's standing evidence rule).
//
// Canonical action messages (sign with personal_sign / EIP-191):
//   register: "flow-exchange:register:<wallet-lowercase>"
//   claim:    "flow-exchange:claim:<PX-ID>:<wallet-lowercase>"
//   deliver:  "flow-exchange:deliver:<PX-ID>:<wallet-lowercase>"
// The register message binds only the wallet (profile fields are
// updatable by re-registering with a fresh signature). Claim and
// deliver bind the listing, so a signature cannot be replayed across
// listings.

const crypto = require("crypto");
const { ethers } = require("ethers");
const px = require("./_exchange");
const x402 = require("./_x402");

const KEY_WORKERS = "pxh:workers";
const KEY_CLAIMS = "pxh:claims";
const KEY_ESCROWS = "pxh:escrows";
const STORE_TIMEOUT_MS = 8000;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN_ID = 8453;

// ---------------------------------------------------------------------------
// Store (Upstash REST — same pattern as _exchange.js, pxh:* namespace)
// ---------------------------------------------------------------------------

function storeConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function cmd(...parts) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) throw new Error("upstash env not configured");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STORE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(parts),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`store responded ${r.status}`);
    const d = await r.json();
    return d.result;
  } finally {
    clearTimeout(timer);
  }
}

async function loadMap(key) {
  const raw = await cmd("GET", key);
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

async function saveMap(key, map) {
  await cmd("SET", key, JSON.stringify(map));
}

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const LISTING_RE = /^PX-\d{4}$/;

function registerMessage(wallet) {
  return `flow-exchange:register:${String(wallet).toLowerCase()}`;
}
function claimMessage(listingId, wallet) {
  return `flow-exchange:claim:${String(listingId).toUpperCase()}:${String(wallet).toLowerCase()}`;
}
function deliverMessage(listingId, wallet) {
  return `flow-exchange:deliver:${String(listingId).toUpperCase()}:${String(wallet).toLowerCase()}`;
}

// Returns the recovered lowercase address, or null when the signature
// does not verify against the expected message/address.
function verifyActionSig(message, signature, expectedWallet) {
  try {
    if (!signature || !WALLET_RE.test(String(expectedWallet || ""))) return null;
    const recovered = ethers.verifyMessage(message, String(signature));
    if (!recovered) return null;
    return recovered.toLowerCase() === String(expectedWallet).toLowerCase()
      ? recovered.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC_BASE };

function verifyAuthorizationSig(authorization, signature) {
  try {
    const recovered = ethers.verifyTypedData(USDC_DOMAIN, EIP3009_TYPES, authorization, String(signature));
    return recovered && authorization && recovered.toLowerCase() === String(authorization.from).toLowerCase()
      ? recovered.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function sha256hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

async function registerWorker(body) {
  const wallet = String((body && body.wallet) || "").toLowerCase();
  const name = String((body && body.name) || "").trim();
  const headline = String((body && body.headline) || "").trim().slice(0, 140);
  const solverId = String((body && body.solver_id) || "").trim().slice(0, 64);
  let skills = body && body.skills;
  if (!WALLET_RE.test(wallet)) return { status: 400, body: { error: "wallet must be a 0x address", code: "BAD_WALLET" } };
  if (name.length < 2 || name.length > 40) return { status: 400, body: { error: "name must be 2-40 chars", code: "BAD_NAME" } };
  if (!Array.isArray(skills)) skills = [];
  skills = skills.map((s) => String(s).trim().slice(0, 32)).filter(Boolean).slice(0, 8);
  const signer = verifyActionSig(registerMessage(wallet), body && body.signature, wallet);
  if (!signer) {
    return {
      status: 401,
      body: {
        error: "signature must be personal_sign of the register message by the wallet",
        code: "BAD_SIGNATURE",
        sign_message: registerMessage(wallet),
      },
    };
  }
  const workers = await loadMap(KEY_WORKERS);
  const existing = workers[wallet] || {};
  const worker = {
    id: wallet,
    wallet,
    name,
    headline,
    skills,
    solver_id: solverId || existing.solver_id || "",
    registered_at: existing.registered_at || nowIso(),
    updated_at: nowIso(),
  };
  workers[wallet] = worker;
  await saveMap(KEY_WORKERS, workers);
  return { status: 200, body: { ok: true, worker } };
}

// The public record merged onto a profile: exchange passport counts
// (by solver_id when linked, else by wallet id) + hub claims.
async function workerProfile(wallet) {
  const workers = await loadMap(KEY_WORKERS);
  const worker = workers[String(wallet).toLowerCase()];
  if (!worker) return null;
  const claims = await loadMap(KEY_CLAIMS);
  const mine = Object.values(claims).filter((c) => c.worker === worker.id);
  let record = { solved: 0, failed: 0, graded: 0 };
  try {
    const { state } = await px.loadState();
    const solvers = state.solvers || {};
    const rec = (worker.solver_id && solvers[worker.solver_id]) || solvers[worker.id] || null;
    if (rec) record = { solved: rec.solved || 0, failed: rec.failed || 0, graded: rec.graded || 0 };
  } catch { /* passport read is best-effort */ }
  return {
    ...worker,
    record,
    claims: mine.map((c) => ({ listing: c.listing, status: c.status, at: c.at, delivered_at: c.delivered_at || null })),
    settled_usd: mine.filter((c) => c.status === "SETTLED").reduce((sum, c) => sum + (c.amount_usd || 0), 0),
  };
}

async function workersDirectory() {
  const workers = await loadMap(KEY_WORKERS);
  const out = [];
  for (const w of Object.values(workers)) {
    const profile = await workerProfile(w.id);
    if (profile) out.push(profile);
  }
  out.sort((a, b) => (b.record.solved - a.record.solved) || (b.settled_usd - a.settled_usd) || a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Claims + deliveries (first claim wins; the claim is a public,
// signature-bound statement — grading and settlement stay with the
// board's existing operator flow, which reads these records)
// ---------------------------------------------------------------------------

async function findBoardListing(listingId) {
  const { state } = await px.loadState();
  return px.findListing(state, listingId);
}

async function claimListing(body) {
  const id = String((body && body.id) || "").toUpperCase();
  const wallet = String((body && body.wallet) || "").toLowerCase();
  if (!LISTING_RE.test(id)) return { status: 400, body: { error: "Provide id PX-0001", code: "BAD_ID" } };
  if (!WALLET_RE.test(wallet)) return { status: 400, body: { error: "wallet must be a 0x address", code: "BAD_WALLET" } };
  const workers = await loadMap(KEY_WORKERS);
  if (!workers[wallet]) {
    return { status: 404, body: { error: "register as a worker first (POST /api/exchange/worker)", code: "NOT_REGISTERED" } };
  }
  const signer = verifyActionSig(claimMessage(id, wallet), body && body.signature, wallet);
  if (!signer) {
    return { status: 401, body: { error: "signature must be personal_sign of the claim message by the wallet", code: "BAD_SIGNATURE", sign_message: claimMessage(id, wallet) } };
  }
  const listing = await findBoardListing(id);
  if (!listing) return { status: 404, body: { error: `No listing ${id} on the board`, code: "NO_LISTING" } };
  if (!["OPEN", "BIDDING"].includes(listing.status)) {
    return { status: 409, body: { error: `Listing is ${listing.status} — only OPEN or BIDDING listings can be claimed`, code: "NOT_CLAIMABLE" } };
  }
  const claims = await loadMap(KEY_CLAIMS);
  const existing = claims[id];
  if (existing && ["CLAIMED", "DELIVERED"].includes(existing.status)) {
    return { status: 409, body: { error: `${id} is already claimed by ${existing.worker}`, code: "ALREADY_CLAIMED", claim: existing } };
  }
  const claim = {
    listing: id,
    worker: wallet,
    worker_name: workers[wallet].name,
    status: "CLAIMED",
    at: nowIso(),
    amount_usd: typeof listing.budget?.amount_usd === "number" ? listing.budget.amount_usd : null,
  };
  claims[id] = claim;
  await saveMap(KEY_CLAIMS, claims);
  return { status: 200, body: { ok: true, claim } };
}

async function deliverWork(body) {
  const id = String((body && body.id) || "").toUpperCase();
  const wallet = String((body && body.wallet) || "").toLowerCase();
  const text = String((body && body.text) || "").slice(0, 4000);
  const url = String((body && body.url) || "").trim().slice(0, 500);
  if (!LISTING_RE.test(id)) return { status: 400, body: { error: "Provide id PX-0001", code: "BAD_ID" } };
  if (!text && !url) return { status: 400, body: { error: "deliverable needs text and/or url", code: "EMPTY_DELIVERABLE" } };
  if (url && !/^https:\/\//.test(url)) return { status: 400, body: { error: "url must be https", code: "BAD_URL" } };
  const signer = verifyActionSig(deliverMessage(id, wallet), body && body.signature, wallet);
  if (!signer) {
    return { status: 401, body: { error: "signature must be personal_sign of the deliver message by the claiming wallet", code: "BAD_SIGNATURE", sign_message: deliverMessage(id, wallet) } };
  }
  const claims = await loadMap(KEY_CLAIMS);
  const claim = claims[id];
  if (!claim) return { status: 404, body: { error: `No claim on ${id}`, code: "NO_CLAIM" } };
  if (claim.worker !== wallet) return { status: 403, body: { error: `${id} is claimed by ${claim.worker}`, code: "NOT_YOUR_CLAIM" } };
  if (claim.status !== "CLAIMED") return { status: 409, body: { error: `Claim is ${claim.status}`, code: "BAD_CLAIM_STATE" } };
  claim.status = "DELIVERED";
  claim.delivered_at = nowIso();
  claim.deliverable = { text: text || null, url: url || null, sha256: text ? sha256hex(text) : null };
  claims[id] = claim;
  await saveMap(KEY_CLAIMS, claims);
  return { status: 200, body: { ok: true, claim } };
}

// Public claim view for the board (no signatures are ever stored on
// claims, so the record is safe to publish as-is).
async function publicClaims() {
  return loadMap(KEY_CLAIMS);
}

// ---------------------------------------------------------------------------
// Escrow — poster-signed EIP-3009 authorization, held unsettled
// ---------------------------------------------------------------------------

function escrowRequirement(amountAtomic, workerWallet) {
  return x402.paymentRequirementFor({ path: "/api/exchange/escrow" }, amountAtomic, workerWallet);
}

async function depositEscrow(body) {
  const id = String((body && body.id) || "").toUpperCase();
  const payload = body && body.payment;
  if (!LISTING_RE.test(id)) return { status: 400, body: { error: "Provide id PX-0001", code: "BAD_ID" } };
  if (!payload || typeof payload !== "object" || !payload.payload || !payload.payload.authorization) {
    return { status: 400, body: { error: "payment must be an x402 v2 payload carrying an EIP-3009 authorization", code: "BAD_PAYMENT" } };
  }
  const listing = await findBoardListing(id);
  if (!listing) return { status: 404, body: { error: `No listing ${id} on the board`, code: "NO_LISTING" } };
  const amountUsd = listing.budget && typeof listing.budget.amount_usd === "number" ? listing.budget.amount_usd : null;
  if (!amountUsd || amountUsd <= 0) {
    return { status: 409, body: { error: `Listing ${id} has no fixed USD budget — escrow needs an exact amount`, code: "NO_FIXED_BUDGET" } };
  }
  const claims = await loadMap(KEY_CLAIMS);
  const claim = claims[id];
  if (!claim || !["CLAIMED", "DELIVERED"].includes(claim.status)) {
    return { status: 409, body: { error: `${id} has no active claim — escrow locks to the claimed worker`, code: "NO_ACTIVE_CLAIM" } };
  }
  const amountAtomic = String(Math.round(amountUsd * 1e6));
  const requirement = escrowRequirement(amountAtomic, claim.worker);
  const localErr = x402.localChecksFor(payload, requirement);
  if (localErr) return { status: 400, body: { error: localErr, code: "PAYMENT_MISMATCH" } };
  const auth = payload.payload.authorization;
  const signer = verifyAuthorizationSig(auth, payload.payload.signature);
  if (!signer) return { status: 400, body: { error: "authorization signature does not recover to authorization.from", code: "BAD_AUTHORIZATION_SIG" } };
  const now = Math.floor(Date.now() / 1000);
  const validBefore = Number(auth.validBefore);
  if (!Number.isFinite(validBefore) || validBefore < now + 120) {
    return { status: 400, body: { error: "authorization expires too soon (validBefore must be at least 2 minutes out)", code: "EXPIRING" } };
  }
  if (validBefore > now + 30 * 24 * 3600) {
    return { status: 400, body: { error: "authorization window too long (30 days max)", code: "WINDOW_TOO_LONG" } };
  }
  const escrows = await loadMap(KEY_ESCROWS);
  const existing = escrows[id];
  if (existing && existing.status === "HELD") {
    return { status: 409, body: { error: `${id} already has a held escrow`, code: "ESCROW_HELD", escrow: publicEscrow(existing) } };
  }
  const escrow = {
    listing: id,
    poster: String(auth.from).toLowerCase(),
    worker: claim.worker,
    amount_usd: amountUsd,
    amount_atomic: amountAtomic,
    status: "HELD",
    at: nowIso(),
    valid_before: validBefore,
    payload: {
      x402Version: 2,
      scheme: "exact",
      network: requirement.network,
      accepted: requirement,
      payload: { authorization: auth, signature: payload.payload.signature },
    },
  };
  escrows[id] = escrow;
  await saveMap(KEY_ESCROWS, escrows);
  return { status: 200, body: { ok: true, escrow: publicEscrow(escrow) } };
}

// Public escrow view: everything except the signature itself.
function publicEscrow(e) {
  if (!e) return null;
  const { payload, ...rest } = e;
  return {
    ...rest,
    authorization: payload && payload.payload ? payload.payload.authorization : null,
  };
}

async function getEscrow(id) {
  const escrows = await loadMap(KEY_ESCROWS);
  return publicEscrow(escrows[String(id || "").toUpperCase()] || null);
}

// Operator-only: settle a held escrow after the board grade passes.
// Mirrors api/exchange/settle's evidence rule exactly — no tx ref,
// no SETTLED.
async function releaseEscrow(req, body) {
  const auth = await px.operatorAuthed(req);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  const id = String((body && body.id) || "").toUpperCase();
  if (!LISTING_RE.test(id)) return { status: 400, body: { error: "Provide id PX-0001", code: "BAD_ID" } };
  const escrows = await loadMap(KEY_ESCROWS);
  const escrow = escrows[id];
  if (!escrow) return { status: 404, body: { error: `No escrow on ${id}`, code: "NO_ESCROW" } };
  if (escrow.status !== "HELD") return { status: 409, body: { error: `Escrow is ${escrow.status}`, code: "BAD_ESCROW_STATE" } };
  const state = await px.loadStateForWrite();
  const listing = px.findListing(state, id);
  if (!listing) return { status: 404, body: { error: `No listing ${id}`, code: "NO_LISTING" } };
  if (listing.status !== "GRADED_PASS") {
    return { status: 409, body: { error: `Listing is ${listing.status} — only GRADED_PASS listings release escrow`, code: "NOT_GRADED_PASS" } };
  }
  const requirement = escrowRequirement(escrow.amount_atomic, escrow.worker);
  let settled;
  try {
    settled = await x402.settlePayment({ payload: escrow.payload, requirements: requirement });
  } catch (e) {
    return { status: 502, body: { error: `facilitator settle failed: ${e.message}`, code: "SETTLE_FAILED" } };
  }
  const resp = settled.response || {};
  const tx = resp.transaction || resp.txHash || resp.tx || null;
  if (!settled.success || !tx) {
    return { status: 502, body: { error: "facilitator did not confirm settlement with a tx ref — escrow stays HELD", code: "SETTLE_UNCONFIRMED", facilitator: resp } };
  }
  // Board state: same mutations as POST /api/exchange/settle.
  listing.verdict = listing.verdict || {};
  listing.verdict.evidence = [
    ...(listing.verdict.evidence || []),
    { kind: "tx", ref: String(tx) },
  ];
  listing.status = "SETTLED";
  px.applyEvent(listing, "SETTLED", { tx: String(tx), via: "hub-escrow" });
  px.recordEvent(state, "SETTLED", id, { tx: String(tx), via: "hub-escrow" });
  await px.saveState(state);
  // Hub records: escrow released, claim settled.
  escrow.status = "RELEASED";
  escrow.tx = String(tx);
  escrow.released_at = nowIso();
  escrows[id] = escrow;
  await saveMap(KEY_ESCROWS, escrows);
  const claims = await loadMap(KEY_CLAIMS);
  if (claims[id]) {
    claims[id].status = "SETTLED";
    claims[id].settled_tx = String(tx);
    claims[id].settled_at = nowIso();
    await saveMap(KEY_CLAIMS, claims);
  }
  return { status: 200, body: { ok: true, escrow: publicEscrow(escrow), listing } };
}

module.exports = {
  storeConfigured,
  registerMessage,
  claimMessage,
  deliverMessage,
  registerWorker,
  workerProfile,
  workersDirectory,
  claimListing,
  deliverWork,
  publicClaims,
  depositEscrow,
  getEscrow,
  releaseEscrow,
  publicEscrow,
};
