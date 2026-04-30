require('dotenv').config();
const express = require('express');
const mysql   = require('mysql2');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── Database Connection (dengan auto-reconnect) ──────
function createConnection() {
  const db = mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

  db.connect(err => {
    if (err) {
      console.error('DB Error:', err.message);
      setTimeout(createConnection, 3000);
      return;
    }
    console.log('✅ MySQL Filess.io Connected');
  });

  db.on('error', err => {
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
      console.log('🔄 Reconnecting...');
      createConnection();
    } else {
      throw err;
    }
  });

  return db;
}

const db = createConnection();

// ── Server Nodes & Round Robin ───────────────────────
const SERVERS = ['server_1', 'server_2', 'server_3'];
let rrIndex = 0;

function getNextServer() {
  const server = SERVERS[rrIndex % SERVERS.length];
  rrIndex++;
  return server;
}

// ── Multer: Dynamic Storage per Server ──────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const server = getNextServer();
    req.targetServer = server;
    const dir = path.join(__dirname, 'uploads', server);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = uuidv4() + path.extname(file.originalname);
    cb(null, unique);
  },
});

const upload = multer({ storage });

// ── Routes ───────────────────────────────────────────

// POST /upload
app.post('/upload', upload.array('files'), (req, res) => {
  const inserted = [];

  req.files.forEach((file) => {
    const serverFolder = path.basename(path.dirname(file.path));
    const sql = `INSERT INTO files (filename, originalname, size, server) VALUES (?, ?, ?, ?)`;
    db.query(sql, [file.filename, file.originalname, file.size, serverFolder],
      (err, result) => {
        if (err) console.error(err);
        else inserted.push({ id: result.insertId, server: serverFolder });
      }
    );
  });

  res.json({ success: true, count: req.files.length, files: inserted });
});

// GET /files
app.get('/files', (req, res) => {
  db.query('SELECT * FROM files ORDER BY upload_time DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// DELETE /files/:id
app.delete('/files/:id', (req, res) => {
  db.query('SELECT * FROM files WHERE id = ?', [req.params.id], (err, rows) => {
    if (err || !rows.length) return res.status(404).json({ error: 'Not found' });
    const file     = rows[0];
    const filePath = path.join(__dirname, 'uploads', file.server, file.filename);
    fs.unlink(filePath, () => {});
    db.query('DELETE FROM files WHERE id = ?', [req.params.id], () => {
      res.json({ success: true });
    });
  });
});

// GET /stats
app.get('/stats', (req, res) => {
  db.query(
    'SELECT server, COUNT(*) as count, SUM(size) as total_size FROM files GROUP BY server',
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.listen(process.env.PORT || 3000, () =>
  console.log(`🚀 Server running on http://localhost:${process.env.PORT || 3000}`)
);