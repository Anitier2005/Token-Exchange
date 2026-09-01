import { query } from '../db.js';
import { hashPassword, verifyPassword, createSession, destroySession, extractToken, generateUniqueUserId } from '../auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function authRoutes(app) {
  app.post('/api/auth/register', async (req, reply) => {
    const { email, password, role, displayName } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: '邮箱和密码必填' });
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: '邮箱格式不正确（暂不验证真实性）' });
    if (!['trader', 'provider', 'receiver'].includes(role)) {
      return reply.code(400).send({ error: '角色不合法（管理员不可注册）' });
    }
    const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.length) return reply.code(409).send({ error: '该邮箱已注册' });
    const id = await generateUniqueUserId();
    const rows = await query(
      'INSERT INTO users (id, email, password_hash, role, display_name) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [id, email, hashPassword(password), role, displayName || email.split('@')[0]]
    );
    await query('INSERT INTO accounts (user_id, balance) VALUES ($1, 0)', [id]);
    const token = await createSession(id);
    return {
      token,
      user: { id, email, role, displayName: rows[0].display_name },
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body || {};
    const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: '邮箱或密码错误' });
    }
    if (user.status === 'frozen') return reply.code(403).send({ error: '账户已被冻结，无法登录' });
    if (user.status === 'cancelled') return reply.code(403).send({ error: '账户已注销，无法登录' });
    const token = await createSession(user.id);
    return {
      token,
      user: { id: user.id, email: user.email, role: user.role, displayName: user.display_name },
    };
  });

  app.post('/api/auth/logout', { preHandler: app.authHook }, async (req) => {
    await destroySession(extractToken(req));
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: app.authHook }, async (req) => {
    const u = req.user;
    return { id: u.id, email: u.email, role: u.role, displayName: u.display_name, status: u.status };
  });
}
