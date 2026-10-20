const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();

// ─── CORS ─────────────────────────────────────────────────────
// Only allow requests from our own domain and Telegram's WebView
app.use(cors({
  origin: [
    "https://your-app.up.railway.app", // адрес вашего деплоя
    "https://web.telegram.org",
    // Allow local testing
    "null",
    "http://localhost:3000",
  ]
}));

app.use(express.json());

// ─── Serve frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, "frontend")));

// ─── Database connection ──────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

// ─── Create tables on first run ───────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id          SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      username    TEXT,
      first_name  TEXT,
      last_name   TEXT,
      platform    TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS answers (
      id            SERIAL PRIMARY KEY,
      submission_id INTEGER REFERENCES submissions(id),
      person_id     INTEGER,
      person_name   TEXT,
      insights      INTEGER,
      created_at    TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retreats (
      id         SERIAL PRIMARY KEY,
      number     INTEGER UNIQUE,
      title      TEXT NOT NULL,
      starts_at  DATE,
      ends_at    DATE,
      is_active  BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS participants (
      id                SERIAL PRIMARY KEY,
      telegram_id       BIGINT UNIQUE,
      telegram_username TEXT UNIQUE,
      full_name         TEXT NOT NULL,
      initials          TEXT,
      company           TEXT,
      role              TEXT,
      help_with         TEXT,
      strengths         TEXT,
      tags              TEXT[] DEFAULT '{}',
      is_draft          BOOLEAN DEFAULT TRUE,
      updated_by        TEXT DEFAULT 'admin',
      updated_at        TIMESTAMP DEFAULT NOW(),
      created_at        TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retreat_participants (
      retreat_id      INTEGER REFERENCES retreats(id) ON DELETE CASCADE,
      participant_id  INTEGER REFERENCES participants(id) ON DELETE CASCADE,
      role_in_retreat TEXT,
      PRIMARY KEY (retreat_id, participant_id)
    );

    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS retreat_id INTEGER REFERENCES retreats(id);
    ALTER TABLE answers     ADD COLUMN IF NOT EXISTS retreat_id INTEGER REFERENCES retreats(id);

    ALTER TABLE answers ADD COLUMN IF NOT EXISTS is_self BOOLEAN DEFAULT FALSE;

    CREATE INDEX IF NOT EXISTS idx_submissions_retreat ON submissions(retreat_id);
    CREATE INDEX IF NOT EXISTS idx_answers_retreat     ON answers(retreat_id);

    CREATE UNIQUE INDEX IF NOT EXISTS retreats_one_active
      ON retreats(is_active) WHERE is_active;
  `);

  await makeUsernamesCaseInsensitive();

  console.log("Database tables ready");
}

// ─── telegram_username: case-insensitive ──────────────────────
// Telegram usernames are case-insensitive, so @Name and @name are one person.
// citext compares via lower() but stores the original case, which makes the
// UNIQUE constraint and every `telegram_username = $1` lookup case-insensitive
// without touching a single query.
// Skipped with a warning if rows already collide by case — merging them is a
// judgement call (which row keeps the retreat memberships?), not a migration.
async function makeUsernamesCaseInsensitive() {
  const { rows: [column] } = await pool.query(
    `SELECT udt_name FROM information_schema.columns
     WHERE table_name = 'participants' AND column_name = 'telegram_username'`
  );
  if (!column || column.udt_name === "citext") return;

  const dupes = await pool.query(
    `SELECT lower(telegram_username)          AS username,
            array_agg(id        ORDER BY id)  AS ids,
            array_agg(full_name ORDER BY id)  AS names
     FROM participants
     WHERE telegram_username IS NOT NULL
     GROUP BY lower(telegram_username)
     HAVING count(*) > 1`
  );

  if (dupes.rows.length > 0) {
    console.error("telegram_username stays case-sensitive — merge these duplicates, then redeploy:");
    for (const d of dupes.rows) {
      console.error(`  @${d.username}: ids ${d.ids.join(", ")} — ${d.names.join(" / ")}`);
    }
    return;
  }

  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS citext`);
    await pool.query(`ALTER TABLE participants ALTER COLUMN telegram_username TYPE citext`);
    console.log("telegram_username is now case-insensitive (citext)");
  } catch (err) {
    // Degraded but alive: old case-sensitive behaviour, server still boots.
    console.error("Could not switch telegram_username to citext:", err.message);
  }
}

// ─── Telegram signature verification ─────────────────────────
// Proves data genuinely came from Telegram, not a fake request
function verifyTelegramData(initData) {
  const botToken = process.env.BOT_TOKEN;

  // Skip verification if no bot token set (local dev)
  if (!botToken) {
    console.warn("BOT_TOKEN not set — skipping Telegram verification");
    return true;
  }

  // Skip if no initData provided (browser testing)
  if (!initData) return false;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");

    // Sort params alphabetically and join as key=value\n
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${key}=${val}`)
      .join("\n");

    // HMAC-SHA256 with secret key derived from bot token
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const expectedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    return expectedHash === hash;
  } catch (err) {
    console.error("Telegram verification error:", err);
    return false;
  }
}

// Returns the verified Telegram user object from initData, or null
function getVerifiedUser(initData) {
  if (!initData) return null;
  if (!verifyTelegramData(initData)) return null;
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get("user");
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

// ─── Input validation ─────────────────────────────────────────
function validateAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return false;
  if (answers.length > 100) return false;

  for (const answer of answers) {
    if (!Number.isInteger(answer.person_id) || answer.person_id <= 0) return false;
    if (!Number.isInteger(answer.insights)) return false;
    if (answer.insights < 1 || answer.insights > 10) return false;
    if (typeof answer.person_name !== "string") return false;
    if (answer.person_name.trim().length === 0) return false;
    if (answer.person_name.length > 100) return false;
  }

  return true;
}

// ─── Rate limiting (simple in-memory) ────────────────────────
// Limits each telegram_id to 5 submissions per hour
const rateLimitMap = new Map();

function isRateLimited(telegramId) {
  if (!telegramId) return false; // skip for anonymous (browser testing)

  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const maxRequests = 5;

  const key = String(telegramId);
  const record = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };

  // Reset window if expired
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count++;
  rateLimitMap.set(key, record);

  return record.count > maxRequests;
}

// ─── Routes ───────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// List retreats grouped by status: active / past / upcoming
app.get("/retreats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, number, title, starts_at, ends_at, is_active
      FROM retreats
      ORDER BY starts_at DESC NULLS LAST
    `);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let active = null;
    const past = [];
    let upcoming = null;

    for (const r of result.rows) {
      if (r.is_active) {
        active = r;
      } else if (r.ends_at && new Date(r.ends_at) < today) {
        past.push(r);
      } else if (r.starts_at && new Date(r.starts_at) >= today) {
        if (!upcoming || new Date(r.starts_at) < new Date(upcoming.starts_at)) {
          upcoming = r;
        }
      }
    }

    res.json({ active, past, upcoming });
  } catch (err) {
    console.error("Retreats error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Current user's profile (looks up by telegram_id, claims by username if first time)
app.get("/me", async (req, res) => {
  const initData = req.headers["x-telegram-init-data"];
  const user = getVerifiedUser(initData);
  if (!user) return res.json(null); // browser/no-auth — frontend treats as empty form

  try {
    let result = await pool.query(
      `SELECT id, full_name, initials, company, role,
              help_with, strengths, tags, is_draft
       FROM participants WHERE telegram_id = $1`,
      [user.id]
    );

    // First-time visit: try to claim a draft by telegram_username
    if (result.rows.length === 0 && user.username) {
      result = await pool.query(
        `UPDATE participants
         SET telegram_id = $1, updated_at = NOW()
         WHERE telegram_username = $2 AND telegram_id IS NULL
         RETURNING id, full_name, initials, company, role,
                   help_with, strengths, tags, is_draft`,
        [user.id, user.username]
      );
    }

    if (result.rows.length === 0) {
      // No record — return TG-derived fallback name so the form is not empty
      return res.json({
        new: true,
        full_name: [user.first_name, user.last_name].filter(Boolean).join(" "),
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /me error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Save current user's profile (creates a self-owned record if first save)
app.put("/me", async (req, res) => {
  const initData = req.headers["x-telegram-init-data"];
  const user = getVerifiedUser(initData);
  if (!user) return res.status(401).json({ error: "Telegram authentication required" });

  const { full_name, company, role, help_with, strengths, tags } = req.body || {};

  if (!full_name || typeof full_name !== "string" || full_name.length > 200) {
    return res.status(400).json({ error: "full_name is required (≤200 chars)" });
  }
  for (const f of [["company", company], ["role", role], ["help_with", help_with], ["strengths", strengths]]) {
    if (f[1] != null && (typeof f[1] !== "string" || f[1].length > 500)) {
      return res.status(400).json({ error: `${f[0]} must be a string ≤500 chars` });
    }
  }
  const cleanTags = Array.isArray(tags)
    ? tags.filter(t => typeof t === "string" && t.length > 0 && t.length <= 50).slice(0, 20)
    : [];

  const initials = String(full_name)
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join("");

  try {
    const result = await pool.query(
      `INSERT INTO participants
         (telegram_id, telegram_username, full_name, initials,
          company, role, help_with, strengths, tags,
          is_draft, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, 'self', NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET
         telegram_username = COALESCE(EXCLUDED.telegram_username, participants.telegram_username),
         full_name  = EXCLUDED.full_name,
         initials   = EXCLUDED.initials,
         company    = EXCLUDED.company,
         role       = EXCLUDED.role,
         help_with  = EXCLUDED.help_with,
         strengths  = EXCLUDED.strengths,
         tags       = EXCLUDED.tags,
         is_draft   = FALSE,
         updated_by = 'self',
         updated_at = NOW()
       RETURNING id, full_name, initials, company, role,
                 help_with, strengths, tags, is_draft`,
      [
        user.id,
        user.username || null,
        full_name.trim(),
        initials,
        (company || "").trim() || null,
        (role || "").trim() || null,
        (help_with || "").trim() || null,
        (strengths || "").trim() || null,
        cleanTags,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /me error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// All participants — for the Profiles screen
app.get("/participants", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, full_name, initials, company, role,
             help_with, strengths, tags, is_draft, telegram_username
      FROM participants
      ORDER BY full_name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Participants error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Participants of a specific retreat, grouped by role
app.get("/retreats/:id/participants", async (req, res) => {
  const retreatId = parseInt(req.params.id, 10);
  if (!Number.isInteger(retreatId) || retreatId <= 0) {
    return res.status(400).json({ error: "Invalid retreat id" });
  }
  try {
    const result = await pool.query(
      `SELECT p.id, p.full_name, p.initials, rp.role_in_retreat
       FROM retreat_participants rp
       JOIN participants p ON p.id = rp.participant_id
       WHERE rp.retreat_id = $1
       ORDER BY p.full_name`,
      [retreatId]
    );

    const discussed = [];
    const viewers = [];
    const guests = [];
    for (const r of result.rows) {
      const role = (r.role_in_retreat || "").toLowerCase();
      if (role.startsWith("разбир")) discussed.push(r);
      else if (role.startsWith("гост")) guests.push(r);
      else viewers.push(r);
    }
    res.json({ discussed, viewers, guests });
  } catch (err) {
    console.error("Retreat participants error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Receive submission from Mini App
app.post("/submit", async (req, res) => {
  const {
    telegram_id,
    username,
    first_name,
    last_name,
    platform,
    answers,
    retreat_id,
    init_data
  } = req.body;

  const isFromTelegram = verifyTelegramData(init_data);
  if (init_data && !isFromTelegram) {
    return res.status(403).json({ error: "Invalid Telegram data" });
  }

  if (isRateLimited(telegram_id)) {
    return res.status(429).json({ error: "Too many submissions. Try again later." });
  }

  if (!validateAnswers(answers)) {
    return res.status(400).json({ error: "Invalid answers" });
  }

  if (!Number.isInteger(retreat_id) || retreat_id <= 0) {
    return res.status(400).json({ error: "retreat_id is required" });
  }

  try {
    // Verify retreat is currently active
    const retreatCheck = await pool.query(
      `SELECT id FROM retreats WHERE id = $1 AND is_active = TRUE`,
      [retreat_id]
    );
    if (retreatCheck.rows.length === 0) {
      return res.status(400).json({ error: "Retreat is not active" });
    }

    // Detect self-vote
    let selfParticipantId = null;
    if (telegram_id) {
      const self = await pool.query(
        `SELECT id FROM participants WHERE telegram_id = $1`,
        [telegram_id]
      );
      if (self.rows.length > 0) selfParticipantId = self.rows[0].id;
    }

    const subResult = await pool.query(
      `INSERT INTO submissions
         (telegram_id, username, first_name, last_name, platform, retreat_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [telegram_id, username, first_name, last_name, platform, retreat_id]
    );

    const submissionId = subResult.rows[0].id;

    for (const answer of answers) {
      const isSelf = selfParticipantId !== null && answer.person_id === selfParticipantId;
      await pool.query(
        `INSERT INTO answers
           (submission_id, person_id, person_name, insights, retreat_id, is_self)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [submissionId, answer.person_id, answer.person_name, answer.insights, retreat_id, isSelf]
      );
    }

    res.json({ success: true, submission_id: submissionId });
  } catch (err) {
    console.error("Submit error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get leaderboard — for admin
app.get("/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        person_name,
        SUM(insights)   AS total_insights,
        COUNT(*)        AS times_mentioned
      FROM answers
      GROUP BY person_name
      ORDER BY total_insights DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ─── Admin votes monitoring ───────────────────────────────────
// (defined before admin middleware so placement is logical; protected by checkAdmin below)

// ─── Admin middleware ─────────────────────────────────────────
function checkAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.warn("ADMIN_TOKEN not set — admin endpoints disabled");
    return res.status(503).json({ error: "Admin not configured" });
  }
  if (req.headers["x-admin-token"] !== token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Admin routes ─────────────────────────────────────────────

// Vote log — who voted for whom
app.get("/admin/votes", checkAdmin, async (req, res) => {
  const retreatId = req.query.retreat_id ? parseInt(req.query.retreat_id, 10) : null;
  try {
    const result = retreatId
      ? await pool.query(
          `SELECT s.first_name, s.username, a.person_name, a.insights, a.is_self, a.created_at
           FROM answers a
           JOIN submissions s ON s.id = a.submission_id
           WHERE a.retreat_id = $1
           ORDER BY s.created_at DESC, a.insights DESC`,
          [retreatId]
        )
      : await pool.query(
          `SELECT s.first_name, s.username, a.person_name, a.insights,
                  a.is_self, a.retreat_id, a.created_at
           FROM answers a
           JOIN submissions s ON s.id = a.submission_id
           ORDER BY s.created_at DESC, a.insights DESC`
        );
    res.json(result.rows);
  } catch (err) {
    console.error("Admin votes error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// All retreats (no date filtering — for admin management)
app.get("/admin/retreats", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, number, title, starts_at, ends_at, is_active, created_at
      FROM retreats
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Admin retreats error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// All participants with full info (including drafts and telegram_id)
app.get("/admin/participants", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, telegram_id, telegram_username, full_name, initials,
             company, role, help_with, strengths, tags,
             is_draft, updated_by, updated_at, created_at
      FROM participants
      ORDER BY full_name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Admin participants error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Karma stats — optionally filtered by retreat_id
app.get("/admin/stats", checkAdmin, async (req, res) => {
  const retreatId = req.query.retreat_id ? parseInt(req.query.retreat_id, 10) : null;

  try {
    const result = retreatId
      ? await pool.query(`
          SELECT person_name, SUM(insights) AS total_insights, COUNT(*) AS times_mentioned
          FROM answers
          WHERE retreat_id = $1 AND is_self = FALSE
          GROUP BY person_name
          ORDER BY total_insights DESC
        `, [retreatId])
      : await pool.query(`
          SELECT person_name, SUM(insights) AS total_insights, COUNT(*) AS times_mentioned
          FROM answers
          WHERE is_self = FALSE
          GROUP BY person_name
          ORDER BY total_insights DESC
        `);

    res.json(result.rows);
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Delete a retreat (cascades answers → submissions → retreat_participants → retreat)
app.delete("/admin/retreats/:id", checkAdmin, async (req, res) => {
  const retreatId = parseInt(req.params.id, 10);
  if (!Number.isInteger(retreatId) || retreatId <= 0) {
    return res.status(400).json({ error: "Invalid retreat id" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM answers     WHERE retreat_id = $1`, [retreatId]);
    await client.query(`DELETE FROM submissions WHERE retreat_id = $1`, [retreatId]);
    await client.query(`DELETE FROM retreats    WHERE id = $1`,         [retreatId]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Admin delete retreat error:", err);
    res.status(500).json({ error: "Database error" });
  } finally {
    client.release();
  }
});

// Create a retreat
app.post("/admin/retreats", checkAdmin, async (req, res) => {
  const { number, title, starts_at, ends_at } = req.body || {};
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return res.status(400).json({ error: "title is required" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO retreats (number, title, starts_at, ends_at, is_active)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING *`,
      [number || null, title.trim(), starts_at || null, ends_at || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Admin create retreat error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Update retreat (title, dates, activate/deactivate)
app.patch("/admin/retreats/:id", checkAdmin, async (req, res) => {
  const retreatId = parseInt(req.params.id, 10);
  if (!Number.isInteger(retreatId) || retreatId <= 0) {
    return res.status(400).json({ error: "Invalid retreat id" });
  }

  const { number, title, starts_at, ends_at, is_active } = req.body || {};

  try {
    // Activating a retreat deactivates all others first
    if (is_active === true) {
      await pool.query(`UPDATE retreats SET is_active = FALSE`);
    }

    const result = await pool.query(
      `UPDATE retreats SET
         number    = COALESCE($1, number),
         title     = COALESCE($2, title),
         starts_at = COALESCE($3, starts_at),
         ends_at   = COALESCE($4, ends_at),
         is_active = COALESCE($5, is_active)
       WHERE id = $6
       RETURNING *`,
      [
        number   !== undefined ? number   : null,
        title    !== undefined ? title.trim() : null,
        starts_at !== undefined ? starts_at : null,
        ends_at  !== undefined ? ends_at  : null,
        is_active !== undefined ? is_active : null,
        retreatId,
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Retreat not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Admin update retreat error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Add participant to retreat
app.post("/admin/retreats/:id/participants", checkAdmin, async (req, res) => {
  const retreatId = parseInt(req.params.id, 10);
  if (!Number.isInteger(retreatId) || retreatId <= 0) {
    return res.status(400).json({ error: "Invalid retreat id" });
  }

  const { participant_id, role_in_retreat } = req.body || {};
  if (!Number.isInteger(participant_id) || participant_id <= 0) {
    return res.status(400).json({ error: "participant_id is required" });
  }

  try {
    await pool.query(
      `INSERT INTO retreat_participants (retreat_id, participant_id, role_in_retreat)
       VALUES ($1, $2, $3)
       ON CONFLICT (retreat_id, participant_id) DO UPDATE SET role_in_retreat = EXCLUDED.role_in_retreat`,
      [retreatId, participant_id, role_in_retreat || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Admin add participant error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Remove participant from retreat
app.delete("/admin/retreats/:id/participants/:pid", checkAdmin, async (req, res) => {
  const retreatId    = parseInt(req.params.id,  10);
  const participantId = parseInt(req.params.pid, 10);
  if (!Number.isInteger(retreatId) || !Number.isInteger(participantId)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  try {
    await pool.query(
      `DELETE FROM retreat_participants WHERE retreat_id = $1 AND participant_id = $2`,
      [retreatId, participantId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Admin remove participant error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});