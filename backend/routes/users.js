'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');

function safe(u) { if (!u) return null; const { password_hash, ...rest } = u; return rest; }

// GET /api/users — admin: all users; technician: just technician list
router.get('/', authenticate, requireRole('admin','technician'), (req, res) => {
  if (req.user.role === 'technician') {
    const techs = db.prepare(`SELECT id,name,email,role,department FROM users WHERE role IN ('technician','admin') AND is_active=1 ORDER BY name`).all();
    return res.json({ users: techs });
  }
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(safe);
  res.json({ users });
});

// GET /api/users/:id — admin only
router.get('/:id', authenticate, requireRole('admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safe(u) });
});

// POST /api/users — admin creates a user with any role
router.post('/', authenticate, requireRole('admin'), [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role').isIn(['user','technician','admin']).withMessage('Invalid role'),
  body('department').optional().trim(),
  body('phone').optional().trim(),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: errs.array()[0].msg });

  const { name, email, password, role, department = '', phone = '' } = req.body;
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email))
    return res.status(409).json({ error: 'Email already in use.' });

  const id = uuid();
  db.prepare(`INSERT INTO users(id,name,email,password_hash,role,department,phone) VALUES(?,?,?,?,?,?,?)`).run(
    id, name, email, bcrypt.hashSync(password, 12), role, department, phone
  );
  res.status(201).json({ user: safe(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});

// PATCH /api/users/:id — admin edits any user
router.patch('/:id', authenticate, requireRole('admin'), [
  body('name').optional().trim().notEmpty(),
  body('role').optional().isIn(['user','technician','admin']),
  body('department').optional().trim(),
  body('phone').optional().trim(),
  body('is_active').optional().isBoolean(),
  body('password').optional().isLength({ min: 8 }),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: errs.array()[0].msg });

  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });

  // Prevent admin from accidentally locking themselves out
  if (req.params.id === req.user.id && req.body.role && req.body.role !== 'admin')
    return res.status(400).json({ error: 'You cannot change your own role.' });
  if (req.params.id === req.user.id && req.body.is_active === false)
    return res.status(400).json({ error: 'You cannot deactivate your own account.' });

  const { name, role, department, phone, is_active, password } = req.body;
  const hash = password ? bcrypt.hashSync(password, 12) : null;
  const now  = Math.floor(Date.now() / 1000);

  db.prepare(`UPDATE users SET
    name          = COALESCE(?, name),
    role          = COALESCE(?, role),
    department    = COALESCE(?, department),
    phone         = COALESCE(?, phone),
    is_active     = COALESCE(?, is_active),
    password_hash = COALESCE(?, password_hash),
    updated_at    = ?
  WHERE id=?`).run(
    name||null, role||null, department??null, phone??null,
    typeof is_active !== 'undefined' ? (is_active ? 1 : 0) : null,
    hash, now, req.params.id
  );
  res.json({ user: safe(db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id)) });
});

// DELETE /api/users/:id — soft delete (deactivate)
router.delete('/:id', authenticate, requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account.' });
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.prepare(`UPDATE users SET is_active=0, updated_at=strftime('%s','now') WHERE id=?`).run(req.params.id);
  res.json({ message: 'User deactivated.' });
});

module.exports = router;
