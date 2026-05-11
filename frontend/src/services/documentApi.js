// /frontend/src/services/documentApi.js
// New API functions for workflow features — uses existing api.js axios instance

import api from './api';

// ── Documents ──────────────────────────────────────────────────
export const getDocuments = (params = {}) =>
  api.get('/documents', { params }).then(r => r.data);

export const getDocument = (id) =>
  api.get(`/documents/${id}`).then(r => r.data);

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

// ── Status helpers ─────────────────────────────────────────────
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
