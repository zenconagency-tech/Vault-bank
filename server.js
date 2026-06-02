const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const app = express();

// ---------- Database ----------
const db = new Database('vault.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    accountNumber TEXT DEFAULT '',
    routingNumber TEXT DEFAULT '021000021',
    approved INTEGER DEFAULT 1,
    suspended INTEGER DEFAULT 0,
    irsHold INTEGER DEFAULT 0,
    availableBalance REAL DEFAULT 1000,
    currentBalance REAL DEFAULT 1250,
    cardLocked INTEGER DEFAULT 0,
    cardLastFour TEXT DEFAULT '4827',
    cardFull TEXT DEFAULT '4827901234567890',
    cardExpiry TEXT DEFAULT '12/28',
    cardCVV TEXT DEFAULT '321',
    transactionPin TEXT DEFAULT '1234',
    showCardDigits INTEGER DEFAULT 0,
    darkMode INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userEmail TEXT NOT NULL,
    name TEXT,
    dateTime TEXT,
    type TEXT,
    status TEXT,
    amount REAL,
    category TEXT
  );
  CREATE TABLE IF NOT EXISTS payees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userEmail TEXT NOT NULL,
    name TEXT,
    accountNumber TEXT
  );
  CREATE TABLE IF NOT EXISTS bank_info (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    supportEmail TEXT DEFAULT 'support@vaultbank.com',
    supportPhone TEXT DEFAULT '1-800-555-0199'
  );
  INSERT OR IGNORE INTO bank_info (id) VALUES (1);
`);

// Seed default users if table is empty
const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
if (userCount === 0) {
  const insert = db.prepare('INSERT INTO users (id, email, password, name, availableBalance, currentBalance, cardFull, cardCVV) VALUES (?,?,?,?,?,?,?,?)');
  insert.run('u1', 'user@bank.com', 'pass123', 'Alex Johnson', 12450.75, 13750.25, '4827901234567890', '321');
  insert.run('u2', 'maria@example.com', 'pass123', 'Maria Garcia', 500, 750, '9901234567890123', '456');
}

// ---------- Middleware ----------
app.use(express.json());
app.use(session({
  secret: 'vault-real-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 } // 1 hour
}));
app.use(express.static('public'));

// Auth middleware
function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.status(403).json({ error: 'Admin only' });
}

// ---------- Auth ----------
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (email === 'admin@bank.com' && password === 'admin123') {
    req.session.user = { isAdmin: true, email };
    return res.json({ isAdmin: true, email });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.approved || user.suspended) return res.status(403).json({ error: 'Account suspended' });
  if (user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.user = { isAdmin: false, email };
  res.json({ isAdmin: false, email });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

// ---------- User Data ----------
app.get('/api/user', requireLogin, (req, res) => {
  if (req.session.user.isAdmin) return res.json({ isAdmin: true });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(req.session.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password, ...safe } = user;
  const transactions = db.prepare('SELECT * FROM transactions WHERE userEmail = ? ORDER BY dateTime DESC').all(user.email);
  const payees = db.prepare('SELECT * FROM payees WHERE userEmail = ?').all(user.email);
  res.json({ ...safe, transactions, payees });
});

// ---------- Transfer (PIN + IRS) ----------
app.post('/api/transfer', requireLogin, (req, res) => {
  const { toEmail, amount, pin } = req.body;
  if (!toEmail || !amount || !pin) return res.status(400).json({ error: 'Missing fields' });
  const sender = db.prepare('SELECT * FROM users WHERE email = ?').get(req.session.user.email);
  if (!sender) return res.status(404).json({ error: 'User not found' });
  if (pin !== sender.transactionPin) return res.status(403).json({ error: 'Incorrect Transaction PIN' });
  if (sender.irsHold) return res.status(403).json({ error: 'Account under IRS hold' });
  if (sender.availableBalance < amount) return res.status(400).json({ error: 'Insufficient funds' });

  const recipient = db.prepare('SELECT * FROM users WHERE email = ?').get(toEmail);
  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
  if (recipient.suspended) return res.status(400).json({ error: 'Recipient suspended' });

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  db.prepare('UPDATE users SET availableBalance = availableBalance - ?, currentBalance = currentBalance - ? WHERE email = ?').run(amount, amount, req.session.user.email);
  db.prepare('UPDATE users SET availableBalance = availableBalance + ?, currentBalance = currentBalance + ? WHERE email = ?').run(amount, amount, toEmail);
  db.prepare('INSERT INTO transactions (userEmail, name, dateTime, type, status, amount, category) VALUES (?,?,?,?,?,?,?)').run(req.session.user.email, `Transfer to ${toEmail}`, now, 'debit', 'successful', amount, 'Transfer');
  db.prepare('INSERT INTO transactions (userEmail, name, dateTime, type, status, amount, category) VALUES (?,?,?,?,?,?,?)').run(toEmail, `Transfer from ${req.session.user.email}`, now, 'credit', 'successful', amount, 'Transfer');
  res.json({ message: 'Transfer successful' });
});

// ---------- Bill Pay ----------
app.post('/api/billpay', requireLogin, (req, res) => {
  const { payee, amount, pin } = req.body;
  if (!payee || !amount || !pin) return res.status(400).json({ error: 'Missing fields' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(req.session.user.email);
  if (pin !== user.transactionPin) return res.status(403).json({ error: 'Incorrect Transaction PIN' });
  if (user.irsHold) return res.status(403).json({ error: 'Account under IRS hold' });
  if (user.availableBalance < amount) return res.status(400).json({ error: 'Insufficient funds' });

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  db.prepare('UPDATE users SET availableBalance = availableBalance - ?, currentBalance = currentBalance - ? WHERE email = ?').run(amount, amount, req.session.user.email);
  db.prepare('INSERT INTO transactions (userEmail, name, dateTime, type, status, amount, category) VALUES (?,?,?,?,?,?,?)').run(req.session.user.email, `Bill Payment - ${payee}`, now, 'debit', 'successful', amount, 'Bills');
  res.json({ message: 'Bill paid' });
});

// ---------- Deposit ----------
app.post('/api/deposit', requireLogin, (req, res) => {
  const { amount, source } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(req.session.user.email);
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  db.prepare('UPDATE users SET availableBalance = availableBalance + ?, currentBalance = currentBalance + ? WHERE email = ?').run(amount, amount, req.session.user.email);
  db.prepare('INSERT INTO transactions (userEmail, name, dateTime, type, status, amount, category) VALUES (?,?,?,?,?,?,?)').run(req.session.user.email, `Deposit - ${source}`, now, 'credit', 'successful', amount, 'Deposit');
  res.json({ message: 'Deposit successful' });
});

// ---------- Card Lock ----------
app.post('/api/card/lock', requireLogin, (req, res) => {
  const user = db.prepare('SELECT cardLocked FROM users WHERE email = ?').get(req.session.user.email);
  const newStatus = user.cardLocked ? 0 : 1;
  db.prepare('UPDATE users SET cardLocked = ? WHERE email = ?').run(newStatus, req.session.user.email);
  res.json({ locked: !!newStatus });
});

// ---------- Profile Updates ----------
app.post('/api/profile/pin', requireLogin, (req, res) => {
  const { currentPin, newPin } = req.body;
  const user = db.prepare('SELECT transactionPin FROM users WHERE email = ?').get(req.session.user.email);
  if (currentPin !== user.transactionPin) return res.status(400).json({ error: 'Incorrect current PIN' });
  if (!/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'Invalid new PIN' });
  db.prepare('UPDATE users SET transactionPin = ? WHERE email = ?').run(newPin, req.session.user.email);
  res.json({ message: 'PIN updated' });
});

app.post('/api/profile/password', requireLogin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(newPassword, req.session.user.email);
  res.json({ message: 'Password changed' });
});

app.post('/api/profile/card/visibility', requireLogin, (req, res) => {
  const user = db.prepare('SELECT showCardDigits FROM users WHERE email = ?').get(req.session.user.email);
  const newVal = user.showCardDigits ? 0 : 1;
  db.prepare('UPDATE users SET showCardDigits = ? WHERE email = ?').run(newVal, req.session.user.email);
  res.json({ showCardDigits: !!newVal });
});

app.post('/api/profile/darkmode', requireLogin, (req, res) => {
  const { darkMode } = req.body;
  db.prepare('UPDATE users SET darkMode = ? WHERE email = ?').run(darkMode ? 1 : 0, req.session.user.email);
  res.json({ darkMode });
});

// ---------- Bank Info ----------
app.get('/api/bankinfo', (req, res) => {
  const info = db.prepare('SELECT * FROM bank_info WHERE id = 1').get();
  res.json(info);
});

// ---------- Admin Routes ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, name, approved, suspended, irsHold, availableBalance, currentBalance, cardLocked FROM users').all();
  res.json(users);
});

app.post('/api/admin/toggle-suspend', requireAdmin, (req, res) => {
  const { id } = req.body;
  const user = db.prepare('SELECT suspended FROM users WHERE id = ?').get(id);
  db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(user.suspended ? 0 : 1, id);
  res.json({ success: true });
});

app.post('/api/admin/toggle-irs', requireAdmin, (req, res) => {
  const { id } = req.body;
  const user = db.prepare('SELECT irsHold FROM users WHERE id = ?').get(id);
  db.prepare('UPDATE users SET irsHold = ? WHERE id = ?').run(user.irsHold ? 0 : 1, id);
  res.json({ success: true });
});

app.post('/api/admin/delete-user', requireAdmin, (req, res) => {
  const { id } = req.body;
  db.prepare('DELETE FROM transactions WHERE userEmail = (SELECT email FROM users WHERE id = ?)').run(id);
  db.prepare('DELETE FROM payees WHERE userEmail = (SELECT email FROM users WHERE id = ?)').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true });
});

app.post('/api/admin/create-user', requireAdmin, (req, res) => {
  const { name, email, password, balance } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  const id = 'u' + Date.now().toString(36);
  db.prepare('INSERT INTO users (id, email, password, name, availableBalance, currentBalance, cardFull, cardCVV, cardLastFour) VALUES (?,?,?,?,?,?,?,?,?)').run(id, email, password, name, balance, balance, '0000000000000000', '000', '0000');
  res.json({ success: true });
});

app.post('/api/admin/update-balance', requireAdmin, (req, res) => {
  const { id, availableBalance, currentBalance } = req.body;
  db.prepare('UPDATE users SET availableBalance = ?, currentBalance = ? WHERE id = ?').run(availableBalance, currentBalance, id);
  res.json({ success: true });
});

app.post('/api/admin/update-contact', requireAdmin, (req, res) => {
  const { supportEmail, supportPhone } = req.body;
  db.prepare('UPDATE bank_info SET supportEmail = ?, supportPhone = ? WHERE id = 1').run(supportEmail, supportPhone);
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== 'admin123') return res.status(400).json({ error: 'Incorrect current password' });
  // For a real implementation you would update the admin password in the DB.
  res.json({ success: true });
});

app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const txs = db.prepare('SELECT t.*, u.email as userEmail FROM transactions t JOIN users u ON t.userEmail = u.email ORDER BY t.dateTime DESC').all();
  res.json(txs);
});

// Fallback
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vault Bank server on port ${PORT}`));
