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
// Raised from 5mb -> 20mb: proposal PDFs are sent as base64 (~33% larger than
// the raw bytes) alongside the proposal's JSON data in a single request.
app.use(express.json({ limit: "20mb" }));

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
  // Saved proposals: one row per proposal a rep has explicitly chosen to
  // save (via "Save Proposal" in the preview modal). Only the customer-facing
  // PDF is stored here — the internal parts list is regenerated on demand
  // from proposal_data whenever it's actually needed (e.g. a bid is accepted),
  // so it never has to be kept around as its own saved copy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proposals (
      id SERIAL PRIMARY KEY,
      client_id TEXT,
      status TEXT NOT NULL DEFAULT 'saved',
      customer_name TEXT,
      customer_business TEXT,
      customer_address TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      proposal_type_name TEXT,
      proposal_title TEXT,
      rep_name TEXT,
      quote_number TEXT,
      total_amount NUMERIC(12,2),
      proposal_data JSONB NOT NULL,
      pdf_data BYTEA,
      pdf_filename TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // client_id lets a device that saved a proposal while offline push it up
  // later without creating a duplicate row if it retries.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS proposals_client_id_idx
    ON proposals (client_id) WHERE client_id IS NOT NULL;
  `);
  // Migration for databases created before proposal_title existed.
  await pool.query(`ALTER TABLE proposals ADD COLUMN IF NOT EXISTS proposal_title TEXT;`);
}
ensureTable().catch((e) => {
  console.error("Failed to set up database table:", e);
});

function checkAuth(req, res, next) {
  // Accept the key as a header (normal case) or as a query param — the
  // latter is needed for the proposal PDF endpoint, since it's opened
  // directly in an <iframe>/<a href> that can't attach custom headers.
  const key = req.header("x-api-key") || req.query["x-api-key"];
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

/* ---------------- PROPOSALS ---------------- */

// Save (create or update) a proposal. If the app already has a clientId for
// this proposal (assigned the first time it was saved), sending it again
// updates that same row instead of creating a duplicate — this is what makes
// it safe for a rep to tap "Save Proposal" again after editing, or for the
// offline queue to retry a save that didn't confirm the first time.
app.post("/api/proposals", checkAuth, async (req, res) => {
  try {
    const {
      clientId, status, customer, proposalTypeName, proposalTitle, repName,
      quoteNumber, totalAmount, proposalData, pdfBase64, pdfFilename
    } = req.body || {};

    if (!proposalData || typeof proposalData !== "object") {
      return res.status(400).json({ error: "'proposalData' is required" });
    }
    const pdfBuffer = pdfBase64 ? Buffer.from(pdfBase64, "base64") : null;
    const c = customer || {};

    const result = await pool.query(
      `INSERT INTO proposals (
         client_id, status, customer_name, customer_business, customer_address,
         customer_phone, customer_email, proposal_type_name, proposal_title, rep_name,
         quote_number, total_amount, proposal_data, pdf_data, pdf_filename, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (client_id) WHERE client_id IS NOT NULL
       DO UPDATE SET
         status = EXCLUDED.status,
         customer_name = EXCLUDED.customer_name,
         customer_business = EXCLUDED.customer_business,
         customer_address = EXCLUDED.customer_address,
         customer_phone = EXCLUDED.customer_phone,
         customer_email = EXCLUDED.customer_email,
         proposal_type_name = EXCLUDED.proposal_type_name,
         proposal_title = EXCLUDED.proposal_title,
         rep_name = EXCLUDED.rep_name,
         quote_number = EXCLUDED.quote_number,
         total_amount = EXCLUDED.total_amount,
         proposal_data = EXCLUDED.proposal_data,
         pdf_data = COALESCE(EXCLUDED.pdf_data, proposals.pdf_data),
         pdf_filename = COALESCE(EXCLUDED.pdf_filename, proposals.pdf_filename),
         updated_at = now()
       RETURNING id, updated_at`,
      [
        clientId || null, status || "saved", c.name || null, c.business || null,
        c.address || null, c.phone || null, c.email || null, proposalTypeName || null,
        proposalTitle || null, repName || null, quoteNumber || null, totalAmount || null,
        JSON.stringify(proposalData), pdfBuffer, pdfFilename || null
      ]
    );
    res.json({ ok: true, id: result.rows[0].id, updatedAt: result.rows[0].updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// List proposals (no PDF bytes / proposal_data — kept light for the list screen).
app.get("/api/proposals", checkAuth, async (req, res) => {
  try {
    const { status, rep, q } = req.query;
    const clauses = [];
    const params = [];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    if (rep === "__unassigned__") {
      clauses.push(`(rep_name IS NULL OR rep_name = '')`);
    } else if (rep) {
      params.push(rep); clauses.push(`rep_name = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      clauses.push(`(customer_name ILIKE $${idx} OR customer_business ILIKE $${idx} OR quote_number ILIKE $${idx})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT id, client_id, status, customer_name, customer_business, customer_address,
              proposal_type_name, proposal_title,
              rep_name, quote_number, total_amount, created_at, updated_at,
              (pdf_data IS NOT NULL) AS has_pdf
       FROM proposals ${where}
       ORDER BY updated_at DESC
       LIMIT 500`,
      params
    );
    res.json({ proposals: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Full record for one proposal, including proposal_data (used to reopen a
// saved proposal and, e.g., regenerate its parts list). Excludes pdf_data —
// fetch that separately via /api/proposals/:id/pdf so this stays fast.
app.get("/api/proposals/:id", checkAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, client_id, status, customer_name, customer_business, customer_address,
              customer_phone, customer_email, proposal_type_name, proposal_title, rep_name,
              quote_number, total_amount, proposal_data, created_at, updated_at,
              (pdf_data IS NOT NULL) AS has_pdf
       FROM proposals WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/proposals/:id/pdf", checkAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pdf_data, pdf_filename FROM proposals WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0 || !result.rows[0].pdf_data) {
      return res.status(404).json({ error: "No PDF stored for this proposal" });
    }
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="${result.rows[0].pdf_filename || "proposal.pdf"}"`);
    res.send(result.rows[0].pdf_data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/proposals/:id", checkAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM proposals WHERE id = $1", [req.params.id]);
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
