'use strict';
require('dotenv').config();
const db = require('../db/database');
const { v4: uuid } = require('uuid');

const SLA = {
  Critical: parseInt(process.env.SLA_CRITICAL_HOURS) || 4,
  High:     parseInt(process.env.SLA_HIGH_HOURS)     || 8,
  Medium:   parseInt(process.env.SLA_MEDIUM_HOURS)   || 24,
  Low:      parseInt(process.env.SLA_LOW_HOURS)       || 72,
};

function calcDueAt(priority, createdAt) {
  return createdAt + (SLA[priority] || 24) * 3600;
}

function getSlaStatus(ticket) {
  const now = Math.floor(Date.now() / 1000);
  if (!ticket.due_at) return { status: 'none', label: 'No SLA', color: 'gray' };

  if (['Resolved','Closed'].includes(ticket.status)) {
    const finishedAt = ticket.resolved_at || ticket.closed_at || ticket.updated_at;
    const met = finishedAt <= ticket.due_at;
    return { status: met ? 'met' : 'breached', label: met ? 'SLA Met' : 'SLA Breached', color: met ? 'green' : 'red' };
  }

  const remaining = ticket.due_at - now;
  if (remaining < 0) return { status: 'breached', label: 'SLA Breached', color: 'red' };
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  if (h < 1) return { status: 'critical', label: `${m}m left`, color: 'red' };
  if (h < 2) return { status: 'warning', label: `${h}h ${m}m left`, color: 'amber' };
  return { status: 'ok', label: `${h}h left`, color: 'green' };
}

function checkBreaches() {
  if (!db.ready) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const breached = db.prepare(`
      SELECT id, subject, assigned_to, priority FROM tickets
      WHERE status NOT IN ('Resolved','Closed')
        AND due_at IS NOT NULL AND due_at < ?
        AND sla_breached = 0
    `).all(now);

    for (const t of breached) {
      db.prepare(`UPDATE tickets SET sla_breached=1, updated_at=? WHERE id=?`).run(now, t.id);
      const admins = db.prepare(`SELECT id FROM users WHERE role='admin' AND is_active=1`).all();
      const notify = new Set(admins.map(a => a.id));
      if (t.assigned_to) notify.add(t.assigned_to);
      for (const uid of notify) {
        db.prepare(`INSERT INTO notifications(id,user_id,ticket_id,type,title,body) VALUES(?,?,?,?,?,?)`).run(
          uuid(), uid, t.id, 'sla_breach',
          `SLA Breach: ${t.subject}`,
          `Ticket has breached its ${t.priority} priority SLA deadline.`
        );
      }
    }
    if (breached.length) console.log(`[SLA] Marked ${breached.length} breach(es)`);
  } catch(e) { console.error('[SLA] Check failed:', e.message); }
}

module.exports = { calcDueAt, getSlaStatus, checkBreaches, SLA };
