// server.js
// ZKNON coupon engine backend — with real on-chain withdraw

"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const crypto = require("crypto");
const bs58 = require("bs58");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const db = require("./db");

const app = express();

// --- Config -----------------------------------------------------------------

const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || "development";

const POOL_ADDRESS =
  process.env.POOL_ADDRESS ||
  "8hGDXBJqpCZvWaDcbvXykRSb1bKbbJ5Ji4c85ubYvkaA";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const CORS_ORIGINS =
  process.env.CORS_ORIGINS || "https://zknon.com,https://app.zknon.com";

const ENGINE_SECRET_KEY = process.env.ENGINE_SECRET_KEY || "";

const ALLOWED_ORIGINS = CORS_ORIGINS.split(",").map((s) => s.trim());

let connection;
function getConnection() {
  if (!connection) {
    connection = new Connection(SOLANA_RPC_URL, "confirmed");
  }
  return connection;
}

let engineKeypair;
function getEngineKeypair() {
  if (engineKeypair) return engineKeypair;

  if (!ENGINE_SECRET_KEY) {
    throw new Error("ENGINE_SECRET_KEY not configured");
  }

  // Support: JSON array [u8,...] or base58 string
  let secretBytes;
  if (ENGINE_SECRET_KEY.trim().startsWith("[")) {
    secretBytes = Uint8Array.from(JSON.parse(ENGINE_SECRET_KEY));
  } else {
    secretBytes = bs58.decode(ENGINE_SECRET_KEY.trim());
  }
  engineKeypair = Keypair.fromSecretKey(secretBytes);
  console.log(
    "Engine wallet:",
    engineKeypair.publicKey.toBase58(),
    "POOL_ADDRESS:",
    POOL_ADDRESS
  );
  return engineKeypair;
}

// --- Middleware -------------------------------------------------------------

app.use(express.json());

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      console.warn("Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"), false);
    },
  })
);

app.use(morgan("dev"));

app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "CORS not allowed for this origin" });
  }
  return next(err);
});

// --- Helpers ----------------------------------------------------------------

function generateCouponId() {
  const part1 = crypto.randomBytes(2).toString("hex").toUpperCase();
  const part2 = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `CPN-${part1}-${part2}`;
}

function nowIso() {
  return new Date().toISOString();
}

function parseAmountSol(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// --- Routes -----------------------------------------------------------------

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    network: "solana-mainnet",
    pool_address: POOL_ADDRESS,
    rpc_url: SOLANA_RPC_URL ? "configured" : "missing",
    env: NODE_ENV,
  });
});

// Public config for frontend
app.get("/config/public", (req, res) => {
  res.json({
    pool_address: POOL_ADDRESS,
  });
});

// List coupons for a wallet
app.get("/coupons", (req, res) => {
  const wallet = String(req.query.wallet || "").trim();

  if (!wallet) {
    return res.status(400).json({ error: "wallet query param is required" });
  }

  const coupons = db.getCouponsByOwner(wallet).map((c) => {
    const events = db.getEventsForCoupon(c.id, c.owner_wallet);
    return { ...c, events };
  });

  res.json({
    wallet,
    pool_address: POOL_ADDRESS,
    coupons,
  });
});

// Create coupon (off-chain record)
app.post("/coupons", (req, res) => {
  const { wallet, label, amount_sol, expiry } = req.body || {};

  const ownerWallet = String(wallet || "").trim();
  const couponLabel = String(label || "").trim();
  const amount = parseAmountSol(amount_sol);

  if (!ownerWallet) {
    return res.status(400).json({ error: "wallet is required" });
  }
  if (!couponLabel) {
    return res.status(400).json({ error: "label is required" });
  }
  if (amount === null) {
    return res
      .status(400)
      .json({ error: "amount_sol must be a positive number" });
  }

  const id = generateCouponId();
  const createdAt = nowIso();

  const coupon = {
    id,
    label: couponLabel,
    owner_wallet: ownerWallet,
    initial_amount_sol: amount,
    remaining_amount_sol: amount,
    expires_at: expiry || null,
    pool_address: POOL_ADDRESS,
    created_at: createdAt,
  };

  db.createCoupon(coupon);

  db.addEvent({
    coupon_id: id,
    owner_wallet: ownerWallet,
    type: "create",
    amount_sol: amount,
    to_address: ownerWallet,
    note: null,
    tx_sig: null,
    created_at: createdAt,
  });

  res.status(201).json({
    coupon,
  });
});

// Deposit endpoint (called AFTER wallet tx success)
app.post("/coupons/:id/deposit", (req, res) => {
  const { id } = req.params;
  const { wallet, amount_sol, tx_sig } = req.body || {};

  const ownerWallet = String(wallet || "").trim();
  const amount = parseAmountSol(amount_sol);

  if (!ownerWallet) {
    return res.status(400).json({ error: "wallet is required" });
  }
  if (amount === null) {
    return res
      .status(400)
      .json({ error: "amount_sol must be a positive number" });
  }

  const coupon = db.getCouponById(id, ownerWallet);
  if (!coupon) {
    return res.status(404).json({ error: "coupon not found for this wallet" });
  }

  const updated = db.updateCoupon(id, ownerWallet, (c) => {
    const current = Number(c.remaining_amount_sol || 0);
    c.remaining_amount_sol = current + amount;
  });

  const event = db.addEvent({
    coupon_id: id,
    owner_wallet: ownerWallet,
    type: "deposit",
    amount_sol: amount,
    to_address: ownerWallet,
    note: null,
    tx_sig: tx_sig || null,
    created_at: nowIso(),
  });

  res.json({
    coupon: updated,
    event,
  });
});

// Withdraw endpoint with real on-chain transfer from engine wallet
app.post("/coupons/:id/withdraw-onchain", async (req, res) => {
  const { id } = req.params;
  const { wallet, amount_sol, recipient } = req.body || {};

  const ownerWallet = String(wallet || "").trim();
  const toAddress = String(recipient || "").trim();
  const amount = parseAmountSol(amount_sol);

  if (!ownerWallet) {
    return res.status(400).json({ error: "wallet is required" });
  }
  if (!toAddress) {
    return res.status(400).json({ error: "recipient is required" });
  }
  if (amount === null) {
    return res
      .status(400)
      .json({ error: "amount_sol must be a positive number" });
  }

  const coupon = db.getCouponById(id, ownerWallet);
  if (!coupon) {
    return res.status(404).json({ error: "coupon not found for this wallet" });
  }

  const currentRemaining = Number(coupon.remaining_amount_sol || 0);
  if (amount > currentRemaining) {
    return res.status(400).json({ error: "insufficient coupon balance" });
  }

  try {
    const engine = getEngineKeypair();
    const conn = getConnection();

    const recipientPk = new PublicKey(toAddress);
    const lamports = Math.round(amount * LAMPORTS_PER_SOL);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: engine.publicKey,
        toPubkey: recipientPk,
        lamports,
      })
    );

    const sig = await conn.sendTransaction(tx, [engine]);
    await conn.confirmTransaction(sig, "confirmed");

    // Update coupon balance
    const updated = db.updateCoupon(id, ownerWallet, (c) => {
      c.remaining_amount_sol = currentRemaining - amount;
    });

    const event = db.addEvent({
      coupon_id: id,
      owner_wallet: ownerWallet,
      type: "withdraw",
      amount_sol: amount,
      to_address: toAddress,
      note: null,
      tx_sig: sig,
      created_at: nowIso(),
    });

    res.json({
      coupon: updated,
      event,
      tx_sig: sig,
    });
  } catch (err) {
    console.error("withdraw-onchain error:", err);
    return res
      .status(500)
      .json({ error: "on-chain withdraw failed", details: err.message });
  }
});

// ZKNON Pay (still off-chain prototype)
app.post("/pay", (req, res) => {
  const { wallet, coupon_id, amount_sol, merchant, note } = req.body || {};

  const ownerWallet = String(wallet || "").trim();
  const couponId = String(coupon_id || "").trim();
  const merchantWallet = String(merchant || "").trim();
  const amount = parseAmountSol(amount_sol);

  if (!ownerWallet) {
    return res.status(400).json({ error: "wallet is required" });
  }
  if (!couponId) {
    return res.status(400).json({ error: "coupon_id is required" });
  }
  if (!merchantWallet) {
    return res.status(400).json({ error: "merchant is required" });
  }
  if (amount === null) {
    return res
      .status(400)
      .json({ error: "amount_sol must be a positive number" });
  }

  const coupon = db.getCouponById(couponId, ownerWallet);
  if (!coupon) {
    return res
      .status(404)
      .json({ error: "coupon not found for this wallet" });
  }

  const currentRemaining = Number(coupon.remaining_amount_sol || 0);
  if (amount > currentRemaining) {
    return res.status(400).json({ error: "insufficient coupon balance" });
  }

  const updated = db.updateCoupon(couponId, ownerWallet, (c) => {
    c.remaining_amount_sol = currentRemaining - amount;
  });

  const event = db.addEvent({
    coupon_id: couponId,
    owner_wallet: ownerWallet,
    type: "pay",
    amount_sol: amount,
    to_address: merchantWallet,
    note: note || null,
    tx_sig: null,
    created_at: nowIso(),
  });

  res.json({
    coupon: updated,
    event,
  });
});

// Full history
app.get("/coupons/:id/history", (req, res) => {
  const { id } = req.params;
  const wallet = String(req.query.wallet || "").trim();

  if (!wallet) {
    return res.status(400).json({ error: "wallet query param is required" });
  }

  const coupon = db.getCouponById(id, wallet);
  if (!coupon) {
    return res.status(404).json({ error: "coupon not found for this wallet" });
  }

  const events = db.getEventsForCoupon(id, wallet);
  res.json({
    coupon,
    events,
  });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Start server
app.listen(PORT, () => {
  console.log(`ZKNON coupon backend on port ${PORT}`);
  console.log(`Allowed CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`Pool address: ${POOL_ADDRESS}`);
});
