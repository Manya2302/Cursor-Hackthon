import { API_BASE } from '../config'

async function request(path, body) {
  const res = await fetch(`${API_BASE}/api/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

/** Step 1 — name, email, phone → OTP */
export function registerRequestOtp({ name, email, phone }) {
  return request('/register', { name, email, phone })
}

/** Step 2 — verify OTP → DB user + WhatsApp Hi {name} */
export function verifyOtp({ phone, email, otp }) {
  return request('/verify-otp', { phone, email, otp })
}

export function setPassword({ userId, password }) {
  return request('/set-password', { userId, password })
}

export function login({ phone, password }) {
  return request('/login', { phone, password })
}
