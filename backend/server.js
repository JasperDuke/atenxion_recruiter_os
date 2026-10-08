import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.SQLITE_PATH ? path.dirname(process.env.SQLITE_PATH) : path.join(rootDir, 'data'));
const dbPath = process.env.SQLITE_PATH || path.join(rootDir, 'data', 'app.sqlite');
const uploadDir = path.join(dataDir, 'uploads', 'resumes');
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(dbPath);
const adminSessions = new Set();
const ADMIN_EMAIL = 'system@atenxion.ai';
const ADMIN_PASSWORD = '123456';
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS engine_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    atenxion_url TEXT NOT NULL DEFAULT '',
    atenxion_token TEXT NOT NULL DEFAULT '',
    public_app_url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    draft_title TEXT NOT NULL,
    raw_summary TEXT NOT NULL,
    role_title TEXT,
    executive_summary TEXT,
    responsibilities_json TEXT,
    core_qualifications_json TEXT,
    preferred_experience_json TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    polish_event_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TEXT
  );
  CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    resume_filename TEXT NOT NULL,
    resume_original_name TEXT NOT NULL,
    eval_event_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    dossier_json TEXT,
    decision_reason TEXT,
    decision_feedback TEXT,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(job_id, candidate_id)
  );
  CREATE INDEX IF NOT EXISTS applications_job_idx ON applications(job_id);
  CREATE INDEX IF NOT EXISTS applications_candidate_idx ON applications(candidate_id);
`);

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.options('*', cors());
app.use(express.json({ limit: '2mb' }));
app.use('/files', express.static(path.join(dataDir, 'uploads')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.pdf', '.docx'].includes(ext));
  }
});

const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const parseJson = (value, fallback = []) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const configRow = () => db.prepare('SELECT * FROM engine_config WHERE id = 1').get() || { atenxion_url: '', atenxion_token: '', public_app_url: '' };
const publicFileUrl = (filename) => `${(process.env.PUBLIC_FILE_BASE || '').replace(/\/$/, '')}/${filename}`.replace(/^\//, '/');
const jobView = (row) => row && ({
  id: row.id, draftTitle: row.draft_title, rawSummary: row.raw_summary, roleTitle: row.role_title,
  executiveSummary: row.executive_summary, responsibilities: parseJson(row.responsibilities_json),
  coreQualifications: parseJson(row.core_qualifications_json), preferredExperience: parseJson(row.preferred_experience_json),
  status: row.status, polishEventId: row.polish_event_id, createdAt: row.created_at, publishedAt: row.published_at
});
const dossierView = (row) => row.dossier_json ? parseJson(row.dossier_json, null) : null;
const applicationView = (row, includeDossier = true) => ({
  id: row.id, jobId: row.job_id, jobTitle: row.role_title || row.draft_title, candidateId: row.candidate_id,
  candidateName: row.full_name, candidateEmail: row.email, resumeOriginalName: row.resume_original_name,
  resumeUrl: `/files/resumes/${row.resume_filename}`, status: row.status, appliedAt: row.applied_at, updatedAt: row.updated_at,
  decisionReason: row.decision_reason, decisionFeedback: row.decision_feedback, dossier: includeDossier ? dossierView(row) : null
});

function requireAdmin(req, res, next) {
  const token = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !adminSessions.has(token)) return res.status(401).json({ error: 'Admin sign-in required.' });
  next();
}

function configResponse(row) {
  return { configured: Boolean(row.atenxion_url && row.atenxion_token && row.public_app_url), atenxionUrl: row.atenxion_url, publicAppUrl: row.public_app_url, updatedAt: row.updated_at };
}

async function dispatch(payload) {
  const config = configRow();
  if (!config.atenxion_url || !config.atenxion_token) throw new Error('Configure the Atenxion agent URL and bearer token before dispatching.');
  const endpoint = `${config.atenxion_url.replace(/\/$/, '')}/api/trigger/agent-trigger`;
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: config.atenxion_token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Atenxion dispatch failed (${response.status}). ${body.slice(0, 180)}`);
  return body;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/admin/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin email or password.' });
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.add(token);
  res.json({ token, admin: { email: ADMIN_EMAIL } });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  adminSessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/config', requireAdmin, (_req, res) => res.json(configResponse(configRow())));
app.put('/api/config', requireAdmin, (req, res) => {
  const { atenxionUrl = '', atenxionToken = '', publicAppUrl = '' } = req.body || {};
  const previous = configRow();
  const normalized = { url: String(atenxionUrl).trim().replace(/\/$/, ''), token: String(atenxionToken).trim() || previous.atenxion_token, host: String(publicAppUrl).trim().replace(/\/$/, '') };
  if (normalized.url && !/^https?:\/\//i.test(normalized.url)) return res.status(400).json({ error: 'Atenxion URL must start with http:// or https://.' });
  if (normalized.host && !/^https?:\/\//i.test(normalized.host)) return res.status(400).json({ error: 'Public application domain must start with http:// or https://.' });
  db.prepare(`INSERT INTO engine_config (id, atenxion_url, atenxion_token, public_app_url) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET atenxion_url=excluded.atenxion_url, atenxion_token=excluded.atenxion_token, public_app_url=excluded.public_app_url, updated_at=CURRENT_TIMESTAMP`).run(normalized.url, normalized.token, normalized.host);
  res.json(configResponse(configRow()));
});

app.get('/api/jobs', (req, res, next) => {
  if (req.query.includeDrafts === 'true') return requireAdmin(req, res, next);
  const includeDrafts = req.query.includeDrafts === 'true';
  const rows = db.prepare(`SELECT * FROM jobs ${includeDrafts ? '' : "WHERE status = 'published'"} ORDER BY COALESCE(published_at, created_at) DESC`).all();
  res.json(rows.map(jobView));
});
app.get('/api/jobs/:jobId', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!row) return res.status(404).json({ error: 'Job not found.' });
  res.json(jobView(row));
});
app.post('/api/jobs', requireAdmin, (req, res) => {
  const { draftTitle, rawSummary } = req.body || {};
  if (!String(draftTitle || '').trim() || !String(rawSummary || '').trim()) return res.status(400).json({ error: 'Role title and role sketch are required.' });
  const jobId = id('job');
  db.prepare('INSERT INTO jobs (id, draft_title, raw_summary) VALUES (?, ?, ?)').run(jobId, String(draftTitle).trim(), String(rawSummary).trim());
  res.status(201).json(jobView(db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)));
});
app.post('/api/jobs/:jobId/polish', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!row) return res.status(404).json({ error: 'Job not found.' });
  const eventId = id('job_spec');
  db.prepare('UPDATE jobs SET polish_event_id = ?, status = ? WHERE id = ?').run(eventId, 'polishing', row.id);
  const config = configRow();
  try {
    await dispatch({ event_id: eventId, type: 'job_polish', draftTitle: row.draft_title, rawSummary: row.raw_summary, callbackUrl: `${config.public_app_url}/api/callbacks/job-polish` });
    res.json({ dispatched: true, eventId });
  } catch (error) {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('draft', row.id);
    res.status(502).json({ error: error.message });
  }
});
app.put('/api/jobs/:jobId', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!row) return res.status(404).json({ error: 'Job not found.' });
  const { roleTitle, executiveSummary, responsibilities = [], coreQualifications = [], preferredExperience = [] } = req.body || {};
  if (!String(roleTitle || '').trim() || !String(executiveSummary || '').trim()) return res.status(400).json({ error: 'Role title and executive summary are required.' });
  db.prepare('UPDATE jobs SET role_title=?, executive_summary=?, responsibilities_json=?, core_qualifications_json=?, preferred_experience_json=? WHERE id=?').run(String(roleTitle).trim(), String(executiveSummary).trim(), JSON.stringify(responsibilities), JSON.stringify(coreQualifications), JSON.stringify(preferredExperience), row.id);
  res.json(jobView(db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id)));
});
app.post('/api/jobs/:jobId/publish', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!row || !row.role_title || !row.executive_summary) return res.status(400).json({ error: 'Finish reviewing the polished job before publishing.' });
  db.prepare("UPDATE jobs SET status='published', published_at=COALESCE(published_at, CURRENT_TIMESTAMP) WHERE id=?").run(row.id);
  res.json(jobView(db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id)));
});

app.get('/api/jobs/:jobId/applications', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT a.*, c.full_name, c.email, j.role_title, j.draft_title FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE a.job_id=? ORDER BY a.applied_at DESC').all(req.params.jobId);
  res.json(rows.map(row => applicationView(row, true)));
});
app.get('/api/applications/:applicationId', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT a.*, c.full_name, c.email, j.role_title, j.draft_title FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE a.id=?').get(req.params.applicationId);
  if (!row) return res.status(404).json({ error: 'Application not found.' });
  res.json(applicationView(row, true));
});
app.patch('/api/applications/:applicationId/decision', requireAdmin, (req, res) => {
  const { status, decisionReason = '', decisionFeedback = '' } = req.body || {};
  if (!['pending', 'review', 'selected', 'rejected'].includes(status)) return res.status(400).json({ error: 'Choose a valid pipeline status.' });
  if (['selected', 'rejected'].includes(status) && !String(decisionReason).trim()) return res.status(400).json({ error: 'A decision reason is required for a final decision.' });
  const current = db.prepare('SELECT id FROM applications WHERE id=?').get(req.params.applicationId);
  if (!current) return res.status(404).json({ error: 'Application not found.' });
  db.prepare('UPDATE applications SET status=?, decision_reason=?, decision_feedback=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, String(decisionReason).trim(), String(decisionFeedback).trim(), current.id);
  const row = db.prepare('SELECT a.*, c.full_name, c.email, j.role_title, j.draft_title FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE a.id=?').get(current.id);
  res.json(applicationView(row, true));
});

app.post('/api/applications', upload.single('resume'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a PDF or DOCX resume up to 10 MB.' });
  const { jobId, fullName, email } = req.body || {};
  const job = db.prepare("SELECT * FROM jobs WHERE id=? AND status='published'").get(jobId);
  if (!job) { fs.rmSync(req.file.path, { force: true }); return res.status(404).json({ error: 'That role is no longer accepting applications.' }); }
  if (!String(fullName || '').trim() || !/^\S+@\S+\.\S+$/.test(String(email || '').trim())) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'Full name and a valid email are required.' }); }
  const normalizedEmail = String(email).trim().toLowerCase();
  let candidate = db.prepare('SELECT * FROM candidates WHERE lower(email)=lower(?)').get(normalizedEmail);
  if (!candidate) { candidate = { id: id('cand'), full_name: String(fullName).trim(), email: normalizedEmail }; db.prepare('INSERT INTO candidates (id, full_name, email) VALUES (?, ?, ?)').run(candidate.id, candidate.full_name, candidate.email); }
  else db.prepare('UPDATE candidates SET full_name=? WHERE id=?').run(String(fullName).trim(), candidate.id);
  const existing = db.prepare('SELECT id FROM applications WHERE job_id=? AND candidate_id=?').get(job.id, candidate.id);
  if (existing) { fs.rmSync(req.file.path, { force: true }); return res.status(409).json({ error: 'You already applied to this role with this email address.' }); }
  const applicationId = id('app'); const eventId = id('eval');
  db.prepare('INSERT INTO applications (id, job_id, candidate_id, resume_filename, resume_original_name, eval_event_id) VALUES (?, ?, ?, ?, ?, ?)').run(applicationId, job.id, candidate.id, req.file.filename, req.file.originalname, eventId);
  const config = configRow();
  try {
    await dispatch({ event_id: eventId, type: 'resume_eval', jobId: job.id, jobTitle: job.role_title, jobDescription: [job.executive_summary, ...parseJson(job.responsibilities_json), ...parseJson(job.core_qualifications_json)].filter(Boolean).join('\n'), attachments: [`${config.public_app_url}/files/resumes/${req.file.filename}`], callbackUrl: `${config.public_app_url}/api/callbacks/candidate-eval` });
  } catch (error) {
    db.prepare('DELETE FROM applications WHERE id=?').run(applicationId); fs.rmSync(req.file.path, { force: true });
    return res.status(502).json({ error: error.message });
  }
  const row = db.prepare('SELECT a.*, c.full_name, c.email, j.role_title, j.draft_title FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE a.id=?').get(applicationId);
  res.status(201).json(applicationView(row, false));
});
app.get('/api/candidate/applications', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Enter the email used for your application.' });
  const rows = db.prepare('SELECT a.*, c.full_name, c.email, j.role_title, j.draft_title FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE lower(c.email)=? ORDER BY a.applied_at DESC').all(email);
  res.json(rows.map(row => applicationView(row, row.status === 'selected' || row.status === 'rejected')));
});

app.post('/api/callbacks/job-polish', (req, res) => {
  const { event_id: eventId, status, polishedJob } = req.body || {};
  const row = db.prepare('SELECT * FROM jobs WHERE polish_event_id=?').get(eventId);
  if (!row) return res.status(404).json({ error: 'Unknown job polish event.' });
  if (status !== 'completed' || !polishedJob) { db.prepare("UPDATE jobs SET status='draft' WHERE id=?").run(row.id); return res.status(400).json({ error: 'Job polish did not complete.' }); }
  db.prepare('UPDATE jobs SET role_title=?, executive_summary=?, responsibilities_json=?, core_qualifications_json=?, preferred_experience_json=?, status=? WHERE id=?').run(polishedJob.roleTitle || row.draft_title, polishedJob.executiveSummary || '', JSON.stringify(polishedJob.responsibilities || []), JSON.stringify(polishedJob.coreQualifications || []), JSON.stringify(polishedJob.preferredExperience || []), 'ready_for_review', row.id);
  res.json({ received: true });
});
app.post('/api/callbacks/candidate-eval', (req, res) => {
  const { event_id: eventId, status, intelligenceDossier } = req.body || {};
  const row = db.prepare('SELECT id FROM applications WHERE eval_event_id=?').get(eventId);
  if (!row) return res.status(404).json({ error: 'Unknown candidate evaluation event.' });
  if (status !== 'completed' || !intelligenceDossier) return res.status(400).json({ error: 'Candidate evaluation did not complete.' });
  db.prepare("UPDATE applications SET dossier_json=?, status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(intelligenceDossier), row.id);
  res.json({ received: true });
});

const frontendDist = path.join(rootDir, 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => req.path.startsWith('/api') || req.path.startsWith('/files') ? next() : res.sendFile(path.join(frontendDist, 'index.html')));
}

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`Recruiter OS listening on ${port}`));
