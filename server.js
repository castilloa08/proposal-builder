// Minimal key-value sync backend for the S.T.O.P. Proposal Builder.
// Deployed on Railway. Stores everything the app saves (proposal types,
// the quote number counter, etc.) in a single Postgres table, keyed by
// the same "key" the app already uses with window.storage.
//
// This same service also serves the app itself (stop_sales_quote_app.html)
// as a plain webpage, so you only need ONE Railway service — no separate
// static hosting step required. Just make sure stop_sales_quote_app.html
// sits in this same folder/repo, next to server.js.

const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's auto-attached internal Postgres connection (hostname like
  // postgres.railway.internal) runs over their private network and does NOT
  // support SSL — forcing it on breaks every query. Only opt in explicitly
  // via PGSSL=true if you're pointing this at a Postgres provider that
  // actually requires SSL (e.g. a public/external connection string).
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
});

const API_KEY = process.env.SYNC_API_KEY;

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
ensureTable().catch((e) => {
  console.error("Failed to set up database table:", e);
});

function checkAuth(req, res, next) {
  const key = req.header("x-api-key");
  if (!API_KEY) {
    return res.status(500).json({ error: "Server is missing SYNC_API_KEY" });
  }
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", async (req, res) => {
  try{
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  }catch(e){
    console.error("Health check DB failure:", e);
    res.status(500).json({ ok: false, database: "error", message: e.message });
  }
});

app.get("/api/kv/:key", checkAuth, async (req, res) => {
  try {
    const { key } = req.params;
    const result = await pool.query(
      "SELECT value, updated_at FROM kv_store WHERE key = $1",
      [key]
    );
    if (result.rows.length === 0) {
      return res.json({ value: null, updatedAt: null });
    }
    res.json({ value: result.rows[0].value, updatedAt: result.rows[0].updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/kv/:key", checkAuth, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (typeof value !== "string") {
      return res.status(400).json({ error: "'value' must be a string" });
    }
    await pool.query(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, value]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/kv/:key", checkAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM kv_store WHERE key = $1", [req.params.key]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.use(express.static(__dirname, { index: false }));

// Serve the app itself at the root URL, e.g. https://your-app.up.railway.app/
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "stop_sales_quote_app.html"), (err) => {
    if (err) {
      res.status(404).send(
        "stop_sales_quote_app.html wasn't found next to server.js. " +
        "Make sure it's committed in the same repo/folder as server.js."
      );
    }
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Sync backend listening on port " + port));
