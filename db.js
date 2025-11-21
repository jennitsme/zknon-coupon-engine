// db.js
// Simple file-based storage for coupons and coupon events.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const COUPONS_FILE = path.join(DATA_DIR, "coupons.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed || fallback;
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err);
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`Failed to write ${filePath}:`, err);
  }
}

function loadCoupons() {
  ensureDataDir();
  return safeReadJson(COUPONS_FILE, []);
}

function saveCoupons(coupons) {
  ensureDataDir();
  safeWriteJson(COUPONS_FILE, coupons);
}

function loadEvents() {
  ensureDataDir();
  return safeReadJson(EVENTS_FILE, []);
}

function saveEvents(events) {
  ensureDataDir();
  safeWriteJson(EVENTS_FILE, events);
}

// Public API

function createCoupon(coupon) {
  const coupons = loadCoupons();
  coupons.push(coupon);
  saveCoupons(coupons);
  return coupon;
}

function updateCoupon(couponId, ownerWallet, updater) {
  const coupons = loadCoupons();
  const index = coupons.findIndex(
    (c) => c.id === couponId && c.owner_wallet === ownerWallet
  );
  if (index === -1) return null;

  const updated = { ...coupons[index] };
  updater(updated);
  coupons[index] = updated;
  saveCoupons(coupons);
  return updated;
}

function getCouponById(couponId, ownerWallet) {
  const coupons = loadCoupons();
  return coupons.find(
    (c) => c.id === couponId && c.owner_wallet === ownerWallet
  );
}

function getCouponsByOwner(ownerWallet) {
  const coupons = loadCoupons();
  return coupons.filter((c) => c.owner_wallet === ownerWallet);
}

function addEvent(event) {
  const events = loadEvents();
  events.push(event);
  saveEvents(events);
  return event;
}

function getEventsForCoupon(couponId, ownerWallet) {
  const events = loadEvents();
  return events.filter(
    (e) => e.coupon_id === couponId && e.owner_wallet === ownerWallet
  );
}

module.exports = {
  createCoupon,
  updateCoupon,
  getCouponById,
  getCouponsByOwner,
  addEvent,
  getEventsForCoupon,
};
