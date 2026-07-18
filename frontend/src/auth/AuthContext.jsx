import { createContext, useContext, useMemo, useState } from 'react'
import * as authApi from './api'

const STORAGE_SESSION = 'nirvha_session'
const AuthContext = createContext(null)

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_SESSION) || 'null')
  } catch {
    return null
  }
}

function saveSession(session) {
  if (session) localStorage.setItem(STORAGE_SESSION, JSON.stringify(session))
  else localStorage.removeItem(STORAGE_SESSION)
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(loadSession)
  const [pendingOtp, setPendingOtp] = useState(null)

  const value = useMemo(() => {
    async function startRegistration({ name, email, phone }) {
      const result = await authApi.registerRequestOtp({ name, email, phone })
      setPendingOtp({
        name: name.trim(),
        email: result.email,
        phone: result.phone,
        demoOtp: result.demoOtp || '',
        createdAt: Date.now(),
      })
      return { otp: result.demoOtp || '', email: result.email, phone: result.phone }
    }

    async function verifyOtp(code) {
      if (!pendingOtp) {
        throw new Error('No OTP request found. Start registration again.')
      }
      const result = await authApi.verifyOtp({
        phone: pendingOtp.phone,
        email: pendingOtp.email,
        otp: code,
      })
      setPendingOtp(null)
      return {
        ...result.user,
        whatsapp: result.whatsapp,
        passcode: null,
      }
    }

    async function setPassword(userId, password) {
      const result = await authApi.setPassword({ userId, password })
      return result.user
    }

    async function login({ phone, password }) {
      const result = await authApi.login({ phone, password })
      const nextSession = {
        userId: result.user.id,
        name: result.user.name,
        email: result.user.email,
        phone: result.user.phone,
      }
      setSession(nextSession)
      saveSession(nextSession)
      return nextSession
    }

    function logout() {
      setSession(null)
      saveSession(null)
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
  }, [session, pendingOtp])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
