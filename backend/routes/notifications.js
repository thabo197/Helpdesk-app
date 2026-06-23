'use strict';
const router = require('express').Router();
const db = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { getSlaStatus, SLA } = require('../services/sla');

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const notifs = db.prepare(`SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 60`).all(req.user.id);
  res.json({ notifications: notifs, unread: notifs.filter(n => !n.is_read).length });
});

router.patch('/:id/read', authenticate, (req, res) => {
  db.prepare(`UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?`).run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.patch('/read-all', authenticate, (req, res) => {
  db.prepare(`UPDATE notifications SET is_read=1 WHERE user_id=?`).run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
