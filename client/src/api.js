const BASE = '';

export function getToken() {
  return localStorage.getItem('tex_token');
}

export function setAuth(token, user) {
  localStorage.setItem('tex_token', token);
  localStorage.setItem('tex_user', JSON.stringify(user));
}

export function clearAuth() {
  localStorage.removeItem('tex_token');
  localStorage.removeItem('tex_user');
}

export function cachedUser() {
  try {
    return JSON.parse(localStorage.getItem('tex_user'));
  } catch {
    return null;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function fmtMoney(v) {
  return Number(v ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtPrice(v) {
  return Number(v ?? 0).toFixed(4);
}

export function priceClass(n) {
  return n > 0 ? 'price-up' : n < 0 ? 'price-down' : 'price-flat';
}
