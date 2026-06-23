'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 15, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

function safe(u) { if (!u) return null; const { password_hash, ...rest } = u; return rest; }

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}

// POST /api/auth/login
router.post('/login', loginLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: 'Valid email and password are required.' });

  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Incorrect email or password.' });

  const token = issueToken(user);

  // Log session
  db.prepare(`INSERT INTO sessions(id,user_id,expires_at,ip_address,user_agent) VALUES(?,?,?,?,?)`).run(
    uuid(), user.id,
    Math.floor(Date.now()/1000) + 8*3600,
    req.ip,
    (req.headers['user-agent'] || '').slice(0, 255)
  );

  res.json({ token, user: safe(user) });
});

// POST /api/auth/logout
router.post('/logout', authenticate, (req, res) => {
  // Invalidate all sessions for this user (simple approach; JWT itself expires naturally)
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(req.user.id);
  res.json({ message: 'Logged out successfully.' });
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: safe(user) });
});

// PUT /api/auth/me — update own profile
router.put('/me', authenticate, [
  body('name').optional().trim().notEmpty().withMessage('Name cannot be blank'),
  body('department').optional().trim(),
  body('phone').optional().trim(),
  body('current_password').optional(),
  body('new_password').optional().isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: errs.array()[0].msg });

  const { name, department, phone, current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  // If changing password, verify current password first
  if (new_password) {
    if (!current_password) return res.status(400).json({ error: 'Current password is required to set a new one.' });
    if (!bcrypt.compareSync(current_password, user.password_hash))
      return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  const hash = new_password ? bcrypt.hashSync(new_password, 12) : null;
  const now  = Math.floor(Date.now() / 1000);

  db.prepare(`UPDATE users SET
    name          = COALESCE(?, name),
    department    = COALESCE(?, department),
    phone         = COALESCE(?, phone),
    password_hash = COALESCE(?, password_hash),
    updated_at    = ?
  WHERE id = ?`).run(name || null, department ?? null, phone ?? null, hash, now, req.user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: safe(updated) });
});

// POST /api/auth/register  — self-registration (creates 'user' role only)
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Full name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('department').optional().trim(),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: errs.array()[0].msg });

  const { name, email, password, department = '' } = req.body;
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'An account with this email already exists.' });

  const id = uuid();
  db.prepare(`INSERT INTO users(id,name,email,password_hash,role,department) VALUES(?,?,?,?,'user',?)`).run(
    id, name, email, bcrypt.hashSync(password, 12), department
  );
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = issueToken(user);
  res.status(201).json({ token, user: safe(user) });
});

module.exports = router;
