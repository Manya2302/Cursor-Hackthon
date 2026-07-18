/**
 * Backend base URL. Empty string in dev — Vite's proxy (vite.config.js)
 * forwards /api and /webhook to localhost:3000. In production (frontend
 * deployed separately from the backend, e.g. two Render services), set
 * VITE_API_URL to the deployed backend's origin, e.g.
 * https://nirvha-backend.onrender.com
 */
export const API_BASE = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || ''
