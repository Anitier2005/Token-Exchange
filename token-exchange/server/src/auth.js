import crypto from 'node:crypto';
import { query } from './db.js';

// ---------- 密码（scrypt） ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test));
}

// ---------- 会话 ----------
export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  return token;
}

export async function destroySession(token) {
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function getUserByToken(token) {
  if (!token) return null;
  const rows = await query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
    [token]
  );
  return rows[0] || null;
}

export function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.query.token || null;
}

// ---------- Fastify 鉴权 ----------
export async function authHook(req, reply) {
  const user = await getUserByToken(extractToken(req));
  if (!user) {
    return reply.code(401).send({ error: '未登录或会话已失效' });
  }
  if (user.status === 'disabled') {
    return reply.code(403).send({ error: '账户已被禁用' });
  }
  req.user = user;
}

export function roleRequired(...roles) {
  return async (req, reply) => {
    if (!roles.includes(req.user.role)) {
      return reply.code(403).send({ error: '无权限访问该资源' });
    }
  };
}
