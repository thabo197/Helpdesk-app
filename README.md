# HelpDesk IT Ticketing System v2

Full-stack IT support portal.

---

## Requirements

- Node.js v18 or higher
- No other install needed — uses sql.js (pure JavaScript SQLite, no compilation)

---

## Setup (3 steps)

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Edit .env to set your admin credentials before first run
#    INIT_ADMIN_EMAIL and INIT_ADMIN_PASSWORD in .env

# 3. Start the server
npm start
```

Open **http://localhost:3000** in your browser.

**On first startup**, an admin account is automatically created using the credentials in `.env`:
- Default: `admin@helpdesk.local` / `Admin1234!`
- Log in immediately and change the password via Profile → Change Password.

---

## Features

### Authentication
- Secure login with JWT tokens (8-hour sessions)
- Self-registration for new users (creates `user` role)
- Admin can create accounts with any role directly
- Password change requires current password verification
- Rate-limited login (15 attempts per 15 minutes)
- Logout invalidates session

### Roles
| Role | Can Do |
|------|--------|
| **User** | Submit tickets, view own tickets, add comments, upload files |
| **Technician** | View all tickets, manage queue, update status/assignment, internal notes |
| **Admin** | Everything above + user management, reports, delete tickets, change any priority |

### Ticket Management
- Submit with subject, description, category, priority
- Categories: Hardware, Software, Network, Access, Email, Security, Other
- Priorities: Low, Medium, High, Critical
- Statuses: Open → In Progress → Pending User → Resolved → Closed
- Full audit history of every change
- SLA countdown per priority level

### SLA Tracking
| Priority | SLA Window |
|----------|-----------|
| Critical | 4 hours |
| High | 8 hours |
| Medium | 24 hours |
| Low | 72 hours |

Live SLA badges on every ticket. Breach detection runs every 5 minutes.
Configurable in `.env` (SLA_CRITICAL_HOURS, etc.)

### Comments & Notes
- Public comments visible to requester + staff
- Internal notes (staff only) — shown with purple highlight
- Email notifications on new comments (when email enabled)

### File Attachments
- Upload up to 5 files per ticket (10MB each)
- Allowed: images, PDF, Word, Excel, text, CSV, ZIP
- Authenticated file serving

### In-App Notifications
- New ticket, status change, assignment, comment, SLA breach
- Unread count badge in sidebar (polls every 30 seconds)
- Click notification to jump to the relevant ticket

### Email Notifications (disabled by default)
Set `EMAIL_ENABLED=true` in `.env` and configure SMTP.
Emails sent for: ticket created, status changed, new comment, assigned.

### Admin Features
- User management: create, edit role, change department/phone, activate/deactivate
- Reports: ticket volume by category/priority/status, technician workload, 14-day trend, SLA stats
- Full system stats dashboard

---

## Project Layout

```
helpdesk/
├── .env                       ← Configuration (edit before running)
├── package.json
├── helpdesk.db                ← Created automatically on first run
│
├── backend/
│   ├── server.js              ← Express app entry point
│   ├── db/database.js         ← sql.js database layer (no native deps)
│   ├── middleware/
│   │   ├── auth.js            ← JWT verification + role guards
│   │   └── upload.js          ← File upload handling
│   ├── routes/
│   │   ├── auth.js            ← Login, logout, register, profile
│   │   ├── tickets.js         ← Full ticket CRUD + comments + attachments
│   │   ├── users.js           ← Admin user management
│   │   ├── notifications.js   ← In-app notification feed
│   │   └── reports.js         ← Analytics and stats
│   ├── services/
│   │   ├── sla.js             ← SLA calculation and breach detection
│   │   └── email.js           ← Nodemailer + email queue
│   └── uploads/               ← Uploaded files stored here
│
└── frontend/
    └── index.html             ← Full SPA (no build step needed)
```

---

## Environment Variables (.env)

| Key | Default | Description |
|-----|---------|-------------|
| PORT | 3000 | Server port |
| JWT_SECRET | (change this!) | Token signing secret |
| JWT_EXPIRES_IN | 8h | Session duration |
| DB_PATH | ./helpdesk.db | Database file location |
| UPLOAD_DIR | ./backend/uploads | File storage directory |
| MAX_FILE_SIZE_MB | 10 | Max upload size |
| EMAIL_ENABLED | false | Enable email sending |
| EMAIL_HOST | smtp.gmail.com | SMTP host |
| EMAIL_PORT | 587 | SMTP port |
| EMAIL_USER | — | SMTP username |
| EMAIL_PASS | — | SMTP password / app password |
| SLA_CRITICAL_HOURS | 4 | SLA for Critical tickets |
| SLA_HIGH_HOURS | 8 | SLA for High tickets |
| SLA_MEDIUM_HOURS | 24 | SLA for Medium tickets |
| SLA_LOW_HOURS | 72 | SLA for Low tickets |
| INIT_ADMIN_EMAIL | admin@helpdesk.local | First-run admin email |
| INIT_ADMIN_PASSWORD | Admin1234! | First-run admin password |

---

## Enabling Email

1. Set `EMAIL_ENABLED=true` in `.env`
2. For Gmail: enable 2FA → generate an App Password → set as `EMAIL_PASS`
3. Restart the server

---

## Production Checklist

- [ ] Change `JWT_SECRET` to a long random string: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
- [ ] Set `NODE_ENV=production`
- [ ] Change the default admin password immediately after first login
- [ ] Set `FRONTEND_URL` to your domain for CORS
- [ ] Put Nginx or a reverse proxy in front for HTTPS
- [ ] Use PM2 for process management: `npm install -g pm2 && pm2 start backend/server.js --name helpdesk`
