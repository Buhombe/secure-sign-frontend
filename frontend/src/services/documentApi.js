// /frontend/src/services/documentApi.js
//
// HakikiSign document API service layer.
// Updated to support the new cursor-paginated GET /documents endpoint
// and the new GET /documents/stats endpoint.
// All existing functions are preserved unchanged.

import api from './api';

// ── Paginated document list ────────────────────────────────────────────────────
// Replaces the simple `api.get('/documents')` call. Now accepts pagination
// parameters and returns the full server response including cursor metadata.
//
// params:
//   cursor   — opaque continuation token (omit for first page)
//   limit    — items per page (1–100, default 25)
//   status   — status filter ('all' | 'pending' | 'in_progress' | 'signed' | etc.)
//   search   — search string
//   sort     — 'created_at' | 'signed_at'
//   dir      — 'asc' | 'desc'
//
// Returns:
//   { documents, total, nextCursor, hasMore, pageSize, meta }
export const getDocuments = (params = {}) =>
  api.get('/documents', { params }).then(r => r.data);

// ── Dashboard stats (aggregated counts) ───────────────────────────────────────
// New endpoint: returns per-status counts without fetching any document rows.
// More efficient than computing counts from the full document list.
//
// Returns:
//   { stats: { pending, in_progress, completed, declined, voided, expired, total } }
export const getDocumentStats = () =>
  api.get('/documents/stats').then(r => r.data);

// ── Single document ────────────────────────────────────────────────────────────
export const getDocument = (id) =>
  api.get(`/documents/${id}`).then(r => r.data);

// ── Document actions (UNCHANGED) ───────────────────────────────────────────────
export const sendDocument = (id) =>
  api.post(`/documents/${id}/send`).then(r => r.data);

export const voidDocument = (id, reason = '') =>
  api.post(`/documents/${id}/void`, { reason }).then(r => r.data);

export const remindDocument = (id) =>
  api.post(`/documents/${id}/remind`).then(r => r.data);

export const getAuditLog = (id) =>
  api.get(`/audit/document/${id}`).then(r => r.data);

export const downloadAuditPdf = (id) =>
  api.get(`/documents/${id}/audit/pdf`, { responseType: 'blob' }).then(r => r.data);

export const downloadDocument = (id) =>
  api.get(`/documents/${id}/download`).then(r => r.data);

// ── Status helpers (UNCHANGED) ─────────────────────────────────────────────────
export const STATUS = {
  draft:       { label: 'Draft',       color: '#64748b', bg: '#f1f5f9' },
  pending:     { label: 'Pending',     color: '#d97706', bg: '#fef9c3' },
  in_progress: { label: 'In Progress', color: '#2563eb', bg: '#dbeafe' },
  completed:   { label: 'Completed',   color: '#16a34a', bg: '#dcfce7' },
  signed:      { label: 'Signed',      color: '#16a34a', bg: '#dcfce7' },
  voided:      { label: 'Voided',      color: '#dc2626', bg: '#fee2e2' },
  expired:     { label: 'Expired',     color: '#9333ea', bg: '#f3e8ff' },
  declined:    { label: 'Declined',    color: '#b45309', bg: '#fff7ed' },
};

export const getStatusStyle = (status) =>
  STATUS[status] || { label: status, color: '#64748b', bg: '#f1f5f9' };
