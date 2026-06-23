'use strict';
const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const { v4: uuid } = require('uuid');
const path = require('path');
const fs   = require('fs');
const db   = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { upload, UPLOAD_DIR } = require('../middleware/upload');
const { calcDueAt, getSlaStatus } = require('../services/sla');
const { sendTicketCreated, sendStatusChanged, sendNewComment, sendAssigned } = require('../services/email');

const VALID_STATUSES   = ['Open','In Progress','Pending User','Resolved','Closed'];
const VALID_PRIORITIES = ['Low','Medium','High','Critical'];
const VALID_CATEGORIES = ['Hardware','Software','Network','Access','Email','Security','Other'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function enrich(t) {
  if (!t) return null;
  return {
    ...t,
    sla: getSlaStatus(t),
    creator:  db.prepare('SELECT id,name,email,role,department FROM users WHERE id=?').get(t.created_by),
    assignee: t.assigned_to ? db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(t.assigned_to) : null,
    comments: db.prepare(`SELECT c.*,u.name AS author_name,u.role AS author_role FROM comments c
      JOIN users u ON u.id=c.author_id WHERE c.ticket_id=? ORDER BY c.created_at ASC`).all(t.id),
    attachments: db.prepare(`SELECT a.*,u.name AS uploader_name FROM attachments a
      JOIN users u ON u.id=a.uploaded_by WHERE a.ticket_id=? ORDER BY a.created_at ASC`).all(t.id),
    history: db.prepare(`SELECT al.*,u.name AS actor_name FROM audit_log al
      LEFT JOIN users u ON u.id=al.actor_id WHERE al.ticket_id=? ORDER BY al.created_at ASC`).all(t.id),
  };
}

function audit(ticketId, actorId, action, field, oldVal, newVal) {
  db.prepare(`INSERT INTO audit_log(id,ticket_id,actor_id,action,field,old_value,new_value) VALUES(?,?,?,?,?,?,?)`).run(
    uuid(), ticketId, actorId, action, field||null, oldVal != null ? String(oldVal) : null, newVal != null ? String(newVal) : null
  );
}

function notify(userId, ticketId, type, title, body_text) {
  db.prepare(`INSERT INTO notifications(id,user_id,ticket_id,type,title,body) VALUES(?,?,?,?,?,?)`).run(
    uuid(), userId, ticketId, type, title, body_text
  );
}

function canAccess(user, ticket) {
  if (user.role !== 'user') return true;
  return ticket.created_by === user.id;
}

// ── GET /api/tickets ──────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const { status, priority, category, assigned_to, search,
          page=1, per_page=20, sort='updated_at', order='desc' } = req.query;

  const where = []; const params = [];
  if (req.user.role === 'user') { where.push('t.created_by=?'); params.push(req.user.id); }
  if (status)      { where.push('t.status=?');      params.push(status); }
  if (priority)    { where.push('t.priority=?');    params.push(priority); }
  if (category)    { where.push('t.category=?');    params.push(category); }
  if (assigned_to === 'me') { where.push('t.assigned_to=?'); params.push(req.user.id); }
  else if (assigned_to === 'none') { where.push('t.assigned_to IS NULL'); }
  else if (assigned_to) { where.push('t.assigned_to=?'); params.push(assigned_to); }
  if (search) { where.push('(t.subject LIKE ? OR t.description LIKE ?)'); params.push(`%${search}%`,`%${search}%`); }

  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const safeSorts = { created_at:1, updated_at:1, due_at:1, priority:1 };
  const safeSort  = safeSorts[sort] ? `t.${sort}` : 't.updated_at';
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';
  const offset    = (Math.max(1, parseInt(page)) - 1) * parseInt(per_page);
  const limit     = Math.min(100, Math.max(1, parseInt(per_page)));

  const tickets = db.prepare(`
    SELECT t.*, u.name AS creator_name, a.name AS assignee_name
    FROM tickets t
    LEFT JOIN users u ON u.id=t.created_by
    LEFT JOIN users a ON a.id=t.assigned_to
    ${whereSQL} ORDER BY ${safeSort} ${safeOrder} LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${whereSQL}`).get(...params) || { n:0 }).n;

  res.json({
    tickets: tickets.map(t => ({ ...t, sla: getSlaStatus(t) })),
    total, page: parseInt(page), per_page: limit,
    pages: Math.ceil(total / limit),
  });
});

// ── GET /api/tickets/:id ──────────────────────────────────────────────────────
router.get('/:id', authenticate, (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  if (!canAccess(req.user, t)) return res.status(403).json({ error: 'Access denied.' });
  res.json({ ticket: enrich(t) });
});

// ── POST /api/tickets ─────────────────────────────────────────────────────────
router.post('/', authenticate, [
  body('subject').trim().notEmpty().withMessage('Subject is required'),
  body('description').trim().notEmpty().withMessage('Description is required'),
  body('category').isIn(VALID_CATEGORIES).withMessage('Invalid category'),
  body('priority').isIn(VALID_PRIORITIES).withMessage('Invalid priority'),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: errs.array()[0].msg });

  const { subject, description, category, priority } = req.body;
  const now   = Math.floor(Date.now() / 1000);
  const id    = uuid();
  const due   = calcDueAt(priority, now);

  db.prepare(`INSERT INTO tickets(id,subject,description,category,priority,status,created_by,due_at,created_at,updated_at)
    VALUES(?,?,?,?,?,'Open',?,?,?,?)`).run(id, subject, description, category, priority, req.user.id, due, now, now);

  audit(id, req.user.id, 'created', null, null, null);

  // Notify all admins
  const admins = db.prepare(`SELECT id FROM users WHERE role='admin' AND is_active=1`).all();
  for (const a of admins) {
    if (a.id !== req.user.id)
      notify(a.id, id, 'new_ticket', `New ${priority} ticket`, `${req.user.name} submitted: "${subject}"`);
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  sendTicketCreated(ticket, req.user);
  res.status(201).json({ ticket: enrich(ticket) });
});

// ── PATCH /api/tickets/:id ────────────────────────────────────────────────────
router.patch('/:id', authenticate, requireRole('admin','technician'), [
  body('status').optional().isIn(VALID_STATUSES),
  body('priority').optional().isIn(VALID_PRIORITIES),
  body('category').optional().isIn(VALID_CATEGORIES),
  body('assigned_to').optional(),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: errs.array()[0].msg });

  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });

  const now = Math.floor(Date.now() / 1000);
  const { status, priority, category, assigned_to } = req.body;
  const updates = {};

  if (status && status !== t.status) {
    updates.status = status;
    if (status === 'Resolved') updates.resolved_at = now;
    if (status === 'Closed')   updates.closed_at   = now;
    audit(t.id, req.user.id, 'status_changed', 'status', t.status, status);
    // Notify creator
    if (t.created_by !== req.user.id) {
      notify(t.created_by, t.id, 'status', `Ticket ${status}`, `Your ticket "${t.subject}" is now ${status}.`);
      const creator = db.prepare('SELECT * FROM users WHERE id=?').get(t.created_by);
      if (creator) sendStatusChanged(t, creator, status);
    }
  }

  if (priority && priority !== t.priority) {
    updates.priority = priority;
    updates.due_at   = calcDueAt(priority, t.created_at);
    audit(t.id, req.user.id, 'priority_changed', 'priority', t.priority, priority);
  }

  if (category && category !== t.category) {
    updates.category = category;
    audit(t.id, req.user.id, 'category_changed', 'category', t.category, category);
  }

  if (typeof assigned_to !== 'undefined') {
    const newAssignee = assigned_to || null;
    if (newAssignee !== t.assigned_to) {
      updates.assigned_to = newAssignee;
      audit(t.id, req.user.id, 'assigned', 'assigned_to', t.assigned_to, newAssignee);
      if (newAssignee && newAssignee !== req.user.id) {
        notify(newAssignee, t.id, 'assigned', 'Ticket assigned to you', `"${t.subject}" (${priority||t.priority} priority)`);
        const tech = db.prepare('SELECT * FROM users WHERE id=?').get(newAssignee);
        if (tech) sendAssigned(t, tech);
      }
    }
  }

  if (!Object.keys(updates).length) return res.json({ ticket: enrich(t) });

  updates.updated_at = now;
  const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE tickets SET ${sets} WHERE id=?`).run(...Object.values(updates), t.id);
  res.json({ ticket: enrich(db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id)) });
});

// ── DELETE /api/tickets/:id ───────────────────────────────────────────────────
router.delete('/:id', authenticate, requireRole('admin'), (req, res) => {
  const t = db.prepare('SELECT id FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  db.prepare('DELETE FROM tickets WHERE id=?').run(req.params.id);
  res.json({ message: 'Ticket deleted.' });
});

// ── POST /api/tickets/:id/comments ───────────────────────────────────────────
router.post('/:id/comments', authenticate, [
  body('body').trim().notEmpty().withMessage('Comment cannot be empty'),
  body('is_internal').optional().isBoolean(),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: errs.array()[0].msg });

  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  if (!canAccess(req.user, t)) return res.status(403).json({ error: 'Access denied.' });

  const { body: text, is_internal = false } = req.body;
  if (is_internal && req.user.role === 'user') return res.status(403).json({ error: 'Users cannot post internal notes.' });

  const id = uuid();
  db.prepare(`INSERT INTO comments(id,ticket_id,author_id,body,is_internal) VALUES(?,?,?,?,?)`).run(
    id, t.id, req.user.id, text, is_internal ? 1 : 0
  );
  db.prepare(`UPDATE tickets SET updated_at=strftime('%s','now') WHERE id=?`).run(t.id);

  if (!is_internal) {
    const recipients = new Set();
    if (t.created_by !== req.user.id) recipients.add(t.created_by);
    if (t.assigned_to && t.assigned_to !== req.user.id) recipients.add(t.assigned_to);
    for (const uid of recipients) {
      notify(uid, t.id, 'comment', `New reply on "${t.subject}"`, `${req.user.name}: ${text.slice(0,100)}`);
      const r = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
      if (r) sendNewComment(t, req.user, text, r);
    }
  }

  const comment = db.prepare(`SELECT c.*,u.name AS author_name,u.role AS author_role FROM comments c
    JOIN users u ON u.id=c.author_id WHERE c.id=?`).get(id);
  res.status(201).json({ comment });
});

// ── POST /api/tickets/:id/attachments ─────────────────────────────────────────
router.post('/:id/attachments', authenticate, upload.array('files', 5), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found.' });
  if (!canAccess(req.user, t)) return res.status(403).json({ error: 'Access denied.' });
  if (!req.files?.length) return res.status(400).json({ error: 'No files received.' });

  const saved = [];
  for (const f of req.files) {
    const id = uuid();
    db.prepare(`INSERT INTO attachments(id,ticket_id,uploaded_by,stored_name,original_name,mime_type,size_bytes) VALUES(?,?,?,?,?,?,?)`).run(
      id, t.id, req.user.id, f.filename, f.originalname, f.mimetype, f.size
    );
    saved.push({ id, original_name: f.originalname, size_bytes: f.size, mime_type: f.mimetype });
  }
  db.prepare(`UPDATE tickets SET updated_at=strftime('%s','now') WHERE id=?`).run(t.id);
  audit(t.id, req.user.id, 'attachments_added', null, null, `${req.files.length} file(s)`);
  res.status(201).json({ attachments: saved });
});

// ── GET /api/tickets/:id/attachments/:name — download ────────────────────────
router.get('/:id/attachments/:name', authenticate, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE stored_name=? AND ticket_id=?').get(req.params.name, req.params.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found.' });
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!canAccess(req.user, t)) return res.status(403).json({ error: 'Access denied.' });
  const fp = path.join(UPLOAD_DIR, a.stored_name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing from disk.' });
  res.setHeader('Content-Disposition', `inline; filename="${a.original_name}"`);
  res.sendFile(fp);
});

// ── DELETE /api/tickets/:id/attachments/:attachId ─────────────────────────────
router.delete('/:id/attachments/:attachId', authenticate, requireRole('admin','technician'), (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=? AND ticket_id=?').get(req.params.attachId, req.params.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found.' });
  const fp = path.join(UPLOAD_DIR, a.stored_name);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  res.json({ message: 'Attachment removed.' });
});

module.exports = router;
