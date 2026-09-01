import { Router } from 'express';
import { query } from '../db.js';
import { hashPassword, verifyPassword, createSession, destroySession, authRequired } from '../auth.js';

const router = Router();

router.post('/register', async (req, res, next) => {
  try {
    const { username, password, role, displayName } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
    if (!['trader', 'provider', 'receiver'].includes(role)) {
      return res.status(400).json({ error: '角色不合法（管理员不可注册）' });
    }
    const exists = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.length) return res.status(409).json({ error: '用户名已存在' });
    const rows = await query(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4) RETURNING *',
      [username, hashPassword(password), role, displayName || username]
    );
    await query('INSERT INTO accounts (user_id, balance) VALUES ($1, 0)', [rows[0].id]);
    const token = await createSession(rows[0].id);
    res.json({ token, user: { id: rows[0].id, username, role, displayName: rows[0].display_name } });
  } catch (e) { next(e); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const rows = await query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (user.status === 'disabled') return res.status(403).json({ error: '账户已被禁用' });
    const token = await createSession(user.id);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name },
    });
  } catch (e) { next(e); }
});

router.post('/logout', authRequired, async (req, res, next) => {
  try {
    const h = req.headers.authorization || '';
    await destroySession(h.startsWith('Bearer ') ? h.slice(7) : req.query.token);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/me', authRequired, async (req, res) => {
  const u = req.user;
  res.json({ id: u.id, username: u.username, role: u.role, displayName: u.display_name });
});

export default router;
