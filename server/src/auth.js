import crypto from 'node:crypto';
import { query } from './db.js';

// ---------- 账户 ID：15 位纯数字随机数 ----------
export function generateUserId() {
  // 100000000000000 ~ 899999999999999（15 位，处于 JS 安全整数范围内）
  return 100000000000000 + Math.floor(Math.random() * 800000000000000);
}

export async function generateUniqueUserId() {
  for (let i = 0; i < 10; i++) {
    const id = generateUserId();
    const rows = await query('SELECT 1 FROM users WHERE id = $1', [id]);
    if (!rows.length) return id;
  }
  throw new Error('无法生成唯一账户 ID');
}

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
  // 冻结：无法登录和查看；注销：无法登录查看和操作；风控：可登录查看（下单在交易服务层拦截）
  if (user.status === 'frozen') {
    return reply.code(403).send({ error: '账户已被冻结，无法访问' });
  }
  if (user.status === 'cancelled') {
    return reply.code(403).send({ error: '账户已注销' });
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
