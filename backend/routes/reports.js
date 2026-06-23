'use strict';
const router = require('express').Router();
const db = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { SLA } = require('../services/sla');

router.get('/overview', authenticate, requireRole('admin'), (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;

  const q = sql => (db.prepare(sql).get() || {}).n || 0;

  const summary = {
    total:        q('SELECT COUNT(*) AS n FROM tickets'),
    open:         q("SELECT COUNT(*) AS n FROM tickets WHERE status='Open'"),
    in_progress:  q("SELECT COUNT(*) AS n FROM tickets WHERE status='In Progress'"),
    pending_user: q("SELECT COUNT(*) AS n FROM tickets WHERE status='Pending User'"),
    resolved:     q("SELECT COUNT(*) AS n FROM tickets WHERE status='Resolved'"),
    closed:       q("SELECT COUNT(*) AS n FROM tickets WHERE status='Closed'"),
    critical:     q("SELECT COUNT(*) AS n FROM tickets WHERE priority='Critical' AND status NOT IN ('Resolved','Closed')"),
    sla_breached: q("SELECT COUNT(*) AS n FROM tickets WHERE sla_breached=1 AND status NOT IN ('Resolved','Closed')"),
    unassigned:   q("SELECT COUNT(*) AS n FROM tickets WHERE assigned_to IS NULL AND status='Open'"),
    today:        db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE created_at>=?').get(now-day).n,
    this_week:    db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE created_at>=?').get(now-day*7).n,
  };

  const total = summary.total || 1;
  summary.resolution_rate = Math.round((summary.resolved + summary.closed) / total * 100);

  const avgRes = (db.prepare('SELECT AVG(resolved_at - created_at) AS a FROM tickets WHERE resolved_at IS NOT NULL').get() || {}).a;
  summary.avg_resolution_hours = avgRes ? Math.round(avgRes / 3600) : null;

  const byCategory = db.prepare('SELECT category, COUNT(*) AS count FROM tickets GROUP BY category ORDER BY count DESC').all();
  const byPriority = db.prepare('SELECT priority, COUNT(*) AS count FROM tickets GROUP BY priority').all();
  const byStatus   = db.prepare('SELECT status,   COUNT(*) AS count FROM tickets GROUP BY status').all();

  const techLoad = db.prepare(`
    SELECT u.id, u.name, COUNT(t.id) AS open_count
    FROM users u LEFT JOIN tickets t ON t.assigned_to=u.id AND t.status NOT IN ('Resolved','Closed')
    WHERE u.role IN ('technician','admin') AND u.is_active=1
    GROUP BY u.id ORDER BY open_count DESC
  `).all();

  // 14-day trend
  const trend = [];
  for (let i=13; i>=0; i--) {
    const from = now - day*(i+1), to = now - day*i;
    trend.push({
      date: new Date(to*1000).toISOString().slice(0,10),
      count: (db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE created_at>=? AND created_at<?').get(from,to)||{}).n||0,
    });
  }

  res.json({ summary, byCategory, byPriority, byStatus, techLoad, trend, slaConfig: SLA });
});

router.get('/my-stats', authenticate, requireRole('admin','technician'), (req, res) => {
  const uid = req.user.id;
  const g = sql => (db.prepare(sql).get(uid) || {}).n || 0;
  res.json({
    assigned:   g('SELECT COUNT(*) AS n FROM tickets WHERE assigned_to=?'),
    open:       g("SELECT COUNT(*) AS n FROM tickets WHERE assigned_to=? AND status='Open'"),
    in_progress:g("SELECT COUNT(*) AS n FROM tickets WHERE assigned_to=? AND status='In Progress'"),
    resolved:   g("SELECT COUNT(*) AS n FROM tickets WHERE assigned_to=? AND status='Resolved'"),
    breached:   g("SELECT COUNT(*) AS n FROM tickets WHERE assigned_to=? AND sla_breached=1 AND status NOT IN ('Resolved','Closed')"),
  });
});

module.exports = router;
