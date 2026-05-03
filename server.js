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

// ── Connection Pool (stabil untuk production) ────────
const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  port:               parseInt(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  database:           process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    5,
  queueLimit:         0,
  enableKeepAlive:    true,
  keepAliveInitialDelay: 0,
});

// Test koneksi saat startup
pool.getConnection((err, connection) => {
  if (err) {
    console.error('❌ DB Connection Error:', err.message);
    return;
  }
  console.log('✅ MySQL Connected via Pool');
  connection.release();
});

// ── Server Nodes & Round Robin ───────────────────────
const SERVERS = ['server_1', 'server_2', 'server_3'];
let rrIndex = 0;

function getNextServer() {
  const server = SERVERS[rrIndex % SERVERS.length];
  rrIndex++;
  return server;
}

// ── Multer Storage ───────────────────────────────────
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
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Tidak ada file' });
  }

  const inserted = [];
  let done = 0;
  const total = req.files.length;

  req.files.forEach((file) => {
    const serverFolder = path.basename(path.dirname(file.path));
    const sql = `INSERT INTO files (filename, originalname, size, server) VALUES (?, ?, ?, ?)`;

    pool.query(sql, [file.filename, file.originalname, file.size, serverFolder], (err, result) => {
      if (err) {
        console.error('Insert error:', err.message);
      } else {
        inserted.push({ id: result.insertId, server: serverFolder });
      }
      done++;
      if (done === total) {
        res.json({ success: true, count: total, files: inserted });
      }
    });
  });
});

// GET /files
app.get('/files', (req, res) => {
  pool.query('SELECT * FROM files ORDER BY upload_time DESC', (err, rows) => {
    if (err) {
      console.error('GET /files error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// DELETE /files/:id
app.delete('/files/:id', (req, res) => {
  pool.query('SELECT * FROM files WHERE id = ?', [req.params.id], (err, rows) => {
    if (err || !rows.length) return res.status(404).json({ error: 'Not found' });
    const file     = rows[0];
    const filePath = path.join(__dirname, 'uploads', file.server, file.filename);
    fs.unlink(filePath, () => {});
    pool.query('DELETE FROM files WHERE id = ?', [req.params.id], () => {
      res.json({ success: true });
    });
  });
});

// GET /stats
app.get('/stats', (req, res) => {
  pool.query(
    'SELECT server, COUNT(*) as count, SUM(size) as total_size FROM files GROUP BY server',
    (err, rows) => {
      if (err) {
        console.error('GET /stats error:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// GET /health — Railway health check
app.get('/health', (req, res) => {
  pool.query('SELECT 1', (err) => {
    if (err) return res.status(500).json({ status: 'error', db: err.message });
    res.json({ status: 'ok', db: 'connected' });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));