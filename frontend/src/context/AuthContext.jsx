import { createContext, useContext, useMemo, useState } from 'react'

const STORAGE_USERS = 'nirvha_users'
const STORAGE_SESSION = 'nirvha_session'

const AuthContext = createContext(null)

function loadUsers() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_USERS) || '[]')
  } catch {
    return []
  }
}

function saveUsers(users) {
  localStorage.setItem(STORAGE_USERS, JSON.stringify(users))
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_SESSION) || 'null')
  } catch {
    return null
  }
}

function randomDigits(length) {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += Math.floor(Math.random() * 10)
  }
  return out
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '')
}

export function AuthProvider({ children }) {
  const [users, setUsers] = useState(loadUsers)
  const [session, setSession] = useState(loadSession)
  const [pendingOtp, setPendingOtp] = useState(null)

  const value = useMemo(() => {
    function startRegistration({ name, email, phone }) {
      const cleanPhone = normalizePhone(phone)
      const existing = users.find((u) => normalizePhone(u.phone) === cleanPhone)
      if (existing) {
        throw new Error('This phone number is already registered. Please log in.')
      }
      if (users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) {
        throw new Error('This email is already registered. Please log in.')
      }

      const otp = randomDigits(6)
      setPendingOtp({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        phone: cleanPhone,
        otp,
        createdAt: Date.now(),
      })
      return { otp, email: email.trim().toLowerCase() }
    }

    function verifyOtp(code) {
      if (!pendingOtp) {
        throw new Error('No OTP request found. Start registration again.')
      }
      if (Date.now() - pendingOtp.createdAt > 10 * 60 * 1000) {
        setPendingOtp(null)
        throw new Error('OTP expired. Please register again.')
      }
      if (String(code).trim() !== pendingOtp.otp) {
        throw new Error('Incorrect OTP. Check your email and try again.')
      }

      const passcode = randomDigits(6)
      const user = {
        id: crypto.randomUUID(),
        name: pendingOtp.name,
        email: pendingOtp.email,
        phone: pendingOtp.phone,
        passcode,
        createdAt: new Date().toISOString(),
      }

      const next = [...users, user]
      setUsers(next)
      saveUsers(next)
      setPendingOtp(null)
      return user
    }

    function setPassword(userId, password) {
      const index = users.findIndex((u) => u.id === userId)
      if (index === -1) {
        throw new Error('Account not found. Please register again.')
      }
      if (String(password).length < 6) {
        throw new Error('Password must be at least 6 characters.')
      }

      const next = users.map((u, i) =>
        i === index ? { ...u, password: String(password) } : u,
      )
      setUsers(next)
      saveUsers(next)
      return next[index]
    }

    function login({ phone, password }) {
      const cleanPhone = normalizePhone(phone)
      const user = users.find((u) => normalizePhone(u.phone) === cleanPhone)
      if (!user) {
        throw new Error('No account found for this phone number.')
      }
      if (!user.password) {
        throw new Error('No password set for this account. Complete registration first.')
      }
      if (String(password) !== user.password) {
        throw new Error('Incorrect password.')
      }

      const nextSession = {
        userId: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
      }
      setSession(nextSession)
      localStorage.setItem(STORAGE_SESSION, JSON.stringify(nextSession))
      return nextSession
    }

    function logout() {
      setSession(null)
      localStorage.removeItem(STORAGE_SESSION)
    }

    function clearPendingOtp() {
      setPendingOtp(null)
    }

    return {
      session,
      pendingOtp,
      startRegistration,
      verifyOtp,
      setPassword,
      login,
      logout,
      clearPendingOtp,
    }
  }, [users, session, pendingOtp])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
