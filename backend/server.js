'use strict';
require('dotenv').config();
const express     = require('express');
const path        = require('path');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

app.use('/api', rateLimit({ windowMs: 60*1000, max: 300, message: { error: 'Too many requests.' } }));

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/tickets',       require('./routes/tickets'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/reports',       require('./routes/reports'));

// ── Frontend ───────────────────────────────────────────────────────────────────
const FRONTEND = path.join(__dirname, '../frontend');
app.use(express.static(FRONTEND));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(FRONTEND, 'index.html'));
});

// ── Error handler ──────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERR]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${process.env.MAX_FILE_SIZE_MB||10}MB)` });
  if (err.message?.startsWith('File type not allowed')) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

// ── Boot — wait for DB wasm ────────────────────────────────────────────────────
const db = require('./db/database');
const { checkBreaches }   = require('./services/sla');
const { processQueue }    = require('./services/email');

db.ready.then(() => {
  // Background jobs
  setInterval(checkBreaches, 5 * 60 * 1000);   // SLA check every 5 min
  checkBreaches();                               // check immediately on start
  setInterval(processQueue,  2 * 60 * 1000);    // email queue every 2 min

  app.listen(PORT, () => {
    console.log(`\n✅ HelpDesk running → http://localhost:${PORT}`);
    console.log(`   Mode     : ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Database : ${process.env.DB_PATH || './helpdesk.db'}`);
    console.log(`   Email    : ${process.env.EMAIL_ENABLED === 'true' ? 'enabled' : 'disabled (set EMAIL_ENABLED=true to activate)'}\n`);
  });
}).catch(err => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});

module.exports = app;
