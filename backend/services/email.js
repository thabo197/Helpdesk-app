'use strict';
require('dotenv').config();
const nodemailer = require('nodemailer');
const db = require('../db/database');
const { v4: uuid } = require('uuid');

const ENABLED = process.env.EMAIL_ENABLED === 'true';

function queue(to, subject, html) {
  try {
    db.prepare(`INSERT INTO email_queue(id,to_address,subject,html_body) VALUES(?,?,?,?)`).run(uuid(), to, subject, html);
  } catch(e) { console.error('[Email] Queue failed:', e.message); }
}

function wrap(content) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
    <div style="background:#1a1916;padding:18px 24px;border-radius:8px 8px 0 0">
      <h2 style="color:#fff;margin:0;font-size:16px">🖥 HelpDesk Notification</h2>
    </div>
    <div style="background:#fff;border:1px solid #e4e2db;border-top:none;padding:24px;border-radius:0 0 8px 8px">
      ${content}
    </div>
    <p style="font-size:11px;color:#9a9890;margin-top:12px;text-align:center">
      This is an automated message from your IT Help Desk system.
    </p>
  </body></html>`;
}

const T = {
  ticketCreated: (t, user) => ({
    to: user.email, subject: `[HelpDesk] Ticket Created: ${t.id.slice(0,8)} — ${t.subject}`,
    html: wrap(`<p>Hi ${user.name},</p><p>Your support ticket has been submitted successfully.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;background:#f4f3ef;font-weight:600;width:110px">Ticket</td><td style="padding:8px;border:1px solid #e4e2db">${t.id.slice(0,8)}</td></tr>
        <tr><td style="padding:8px;background:#f4f3ef;font-weight:600">Subject</td><td style="padding:8px;border:1px solid #e4e2db">${t.subject}</td></tr>
        <tr><td style="padding:8px;background:#f4f3ef;font-weight:600">Priority</td><td style="padding:8px;border:1px solid #e4e2db">${t.priority}</td></tr>
        <tr><td style="padding:8px;background:#f4f3ef;font-weight:600">Status</td><td style="padding:8px;border:1px solid #e4e2db">Open</td></tr>
      </table>
      <p style="color:#5a5852;font-size:13px">We'll update you as soon as a technician picks this up.</p>`)
  }),
  statusChanged: (t, recipient, newStatus) => ({
    to: recipient.email, subject: `[HelpDesk] Update on your ticket: ${t.subject}`,
    html: wrap(`<p>Hi ${recipient.name},</p>
      <p>Your ticket status has been updated to <strong>${newStatus}</strong>.</p>
      <p><strong>Ticket:</strong> ${t.subject}</p>`)
  }),
  newComment: (t, commenter, body, recipient) => ({
    to: recipient.email, subject: `[HelpDesk] New reply on: ${t.subject}`,
    html: wrap(`<p>Hi ${recipient.name},</p>
      <p><strong>${commenter.name}</strong> replied to your ticket:</p>
      <blockquote style="border-left:3px solid #e4e2db;padding:10px 16px;background:#f9f8f5;margin:16px 0">${body}</blockquote>
      <p><strong>Ticket:</strong> ${t.subject}</p>`)
  }),
  assigned: (t, tech) => ({
    to: tech.email, subject: `[HelpDesk] Ticket assigned to you: ${t.subject}`,
    html: wrap(`<p>Hi ${tech.name},</p>
      <p>A ticket has been assigned to you.</p>
      <p><strong>${t.subject}</strong> — Priority: ${t.priority}</p>`)
  }),
};

async function processQueue() {
  if (!ENABLED) return;
  let transporter;
  try {
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST, port: parseInt(process.env.EMAIL_PORT) || 587,
      secure: parseInt(process.env.EMAIL_PORT) === 465,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  } catch { return; }

  const pending = db.prepare(`SELECT * FROM email_queue WHERE status='pending' AND attempts<3 LIMIT 10`).all();
  for (const e of pending) {
    try {
      await transporter.sendMail({ from: process.env.EMAIL_FROM, to: e.to_address, subject: e.subject, html: e.html_body });
      db.prepare(`UPDATE email_queue SET status='sent', sent_at=strftime('%s','now') WHERE id=?`).run(e.id);
    } catch(err) {
      db.prepare(`UPDATE email_queue SET attempts=attempts+1, last_error=?, status=CASE WHEN attempts+1>=3 THEN 'failed' ELSE 'pending' END WHERE id=?`)
        .run(err.message, e.id);
    }
  }
}

function sendTicketCreated(ticket, user) { if (ENABLED) { const m = T.ticketCreated(ticket,user); queue(m.to,m.subject,m.html); } }
function sendStatusChanged(ticket, recipient, s) { if (ENABLED) { const m = T.statusChanged(ticket,recipient,s); queue(m.to,m.subject,m.html); } }
function sendNewComment(ticket, commenter, body, recipient) { if (ENABLED) { const m = T.newComment(ticket,commenter,body,recipient); queue(m.to,m.subject,m.html); } }
function sendAssigned(ticket, tech) { if (ENABLED) { const m = T.assigned(ticket,tech); queue(m.to,m.subject,m.html); } }

module.exports = { processQueue, sendTicketCreated, sendStatusChanged, sendNewComment, sendAssigned };
