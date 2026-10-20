#!/usr/bin/env node
/**
 * Imports participants from a JSON file into the `participants` table.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/import-participants.js path/to/file.json
 *
 * Idempotent — re-running with the same file updates existing rows
 * (matched by telegram_username). Sets is_draft = TRUE and updated_by = 'admin'.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const FILE = process.argv[2];
if (!FILE) {
  console.error("Usage: node scripts/import-participants.js <file.json>");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(FILE), "utf8");
let rows;
try {
  rows = JSON.parse(raw);
} catch (err) {
  console.error("Invalid JSON:", err.message);
  process.exit(1);
}

if (!Array.isArray(rows)) {
  console.error("Expected a JSON array at the top level");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" || /railway/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

function deriveInitials(fullName) {
  return String(fullName || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join("");
}

function validate(row, idx) {
  if (!row.full_name || typeof row.full_name !== "string") {
    throw new Error(`row ${idx}: full_name is required`);
  }
  if (!row.telegram_username || typeof row.telegram_username !== "string") {
    throw new Error(`row ${idx}: telegram_username is required (used as upsert key)`);
  }
  if (row.tags && !Array.isArray(row.tags)) {
    throw new Error(`row ${idx}: tags must be an array of strings`);
  }
}

async function run() {
  console.log(`Importing ${rows.length} participant(s) from ${FILE}`);

  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    validate(r, i);

    const initials = r.initials || deriveInitials(r.full_name);
    const tags = r.tags || [];

    // Strip leading @ if present
    const username = r.telegram_username.replace(/^@/, "");

    const result = await pool.query(
      `INSERT INTO participants
         (telegram_username, full_name, initials, company, role,
          help_with, strengths, tags, is_draft, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, TRUE, 'admin', NOW())
       ON CONFLICT (telegram_username) DO UPDATE SET
         full_name  = EXCLUDED.full_name,
         initials   = EXCLUDED.initials,
         company    = EXCLUDED.company,
         role       = EXCLUDED.role,
         help_with  = EXCLUDED.help_with,
         strengths  = EXCLUDED.strengths,
         tags       = EXCLUDED.tags,
         updated_by = CASE
                        WHEN participants.updated_by = 'self' THEN 'self'
                        ELSE 'admin'
                      END,
         updated_at = NOW()
       RETURNING (xmax = 0) AS was_inserted`,
      [
        username,
        r.full_name,
        initials,
        r.company || null,
        r.role || null,
        r.help_with || null,
        r.strengths || null,
        tags,
      ]
    );

    if (result.rows[0].was_inserted) inserted++;
    else updated++;
    console.log(`  ${result.rows[0].was_inserted ? "+" : "~"} ${r.full_name} (@${username})`);
  }

  console.log(`\nDone. Inserted: ${inserted}, updated: ${updated}`);
  await pool.end();
}

run().catch(err => {
  console.error("Import failed:", err.message);
  pool.end().finally(() => process.exit(1));
});
