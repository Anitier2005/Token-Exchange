import { query } from '../db.js';
import { hashPassword, verifyPassword, createSession, destroySession, extractToken } from '../auth.js';

export default async function authRoutes(app) {
  app.post('/api/auth/register', async (req, reply) => {
    const { username, password, role, displayName } = req.body || {};
    if (!username || !password) return reply.code(400).send({ error: '用户名和密码必填' });
    if (!['trader', 'provider', 'receiver'].includes(role)) {
      return reply.code(400).send({ error: '角色不合法（管理员不可注册）' });
    }
    const exists = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.length) return reply.code(409).send({ error: '用户名已存在' });
    const rows = await query(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4) RETURNING *',
      [username, hashPassword(password), role, displayName || username]
    );
    await query('INSERT INTO accounts (user_id, balance) VALUES ($1, 0)', [rows[0].id]);
    const token = await createSession(rows[0].id);
    return { token, user: { id: rows[0].id, username, role, displayName: rows[0].display_name } };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const rows = await query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (user.status === 'disabled') return reply.code(403).send({ error: '账户已被禁用' });
    const token = await createSession(user.id);
    return {
      token,
      user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name },
    };
  });

  app.post('/api/auth/logout', { preHandler: app.authHook }, async (req) => {
    await destroySession(extractToken(req));
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: app.authHook }, async (req) => {
    const u = req.user;
    return { id: u.id, username: u.username, role: u.role, displayName: u.display_name };
  });
}
