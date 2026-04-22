import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as pdfjsLib from 'pdfjs-dist/build/pdf';
import api from '../services/api';
import AppShell from '../components/AppShell';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const SIGNER_COLORS = ['#2563eb', '#f59e0b', '#16a34a', '#db2777', '#9333ea', '#0891b2', '#b91c1c', '#65a30d', '#7c3aed', '#0d9488'];

// Default field sizes as percentages of page width/height
const DEFAULT_SIZES = {
  signature: { w: 22, h:  6 },
  initials:  { w: 10, h:  5 },
  date:      { w: 15, h:  3 },
  text:      { w: 20, h:  3 },
  checkbox:  { w:  3, h:  2 },
};

const FIELD_LABELS = {
  signature: 'Signature',
  initials:  'Initials',
  date:      'Date',
  text:      'Text',
  checkbox:  'Check',
};

const FIELD_ICONS = {
  signature: '✍️',
  initials:  '🅰️',
  date:      '📅',
  text:      '📝',
  checkbox:  '☑️',
};

export default function PlaceFields() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [docInfo,      setDocInfo]      = useState(null);
  const [signers,      setSigners]      = useState([]);
  const [pdfDoc,       setPdfDoc]       = useState(null);
  const [pageCount,    setPageCount]    = useState(0);
  const [pageSizes,    setPageSizes]    = useState([]);          // [{width,height}] per page
  const [fields,       setFields]       = useState([]);          // local working set
  const [activeSigner, setActiveSigner] = useState(null);        // signer_id
  const [activeTool,   setActiveTool]   = useState('signature');
  const [selectedId,   setSelectedId]   = useState(null);        // local id (idx-based)
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState('');
  const canvasRefs = useRef({});

  // ── 1. Load doc meta + signers + existing fields + PDF ────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [docRes, signersRes, fieldsRes] = await Promise.all([
          api.get(`/documents/${id}`),
          api.get(`/signers/${id}`),
          api.get(`/fields/${id}`).catch(() => ({ data: { fields: [] } })),
        ]);
        if (cancelled) return;

        setDocInfo(docRes.data.document);
        setSigners(signersRes.data.signers || []);
        if ((signersRes.data.signers || []).length > 0) {
          setActiveSigner(signersRes.data.signers[0].id);
        }

        // Load existing fields (if any) — strip DB ids, use local temp ids
        const existing = (fieldsRes.data.fields || []).map((f, i) => ({
          tempId:      `db-${f.id}`,
          signer_id:   f.signer_id,
          field_type:  f.field_type,
          page_number: f.page_number,
          x_pct:       Number(f.x_pct),
          y_pct:       Number(f.y_pct),
          width_pct:   Number(f.width_pct),
          height_pct:  Number(f.height_pct),
          required:    f.required !== false,
        }));
        setFields(existing);

        // Fetch PDF
        const token = localStorage.getItem('token');
        const pdfRes = await fetch(
          `${api.defaults.baseURL}/documents/${id}/stream`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!pdfRes.ok) throw new Error('Failed to load PDF.');
        const buf = await pdfRes.arrayBuffer();
        if (cancelled) return;

        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        if (cancelled) return;

        setPdfDoc(pdf);
        setPageCount(pdf.numPages);
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message || 'Failed to load.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // ── 2. Render each PDF page into its canvas ───────────────────────────────
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;

    (async () => {
      const sizes = [];
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        if (cancelled) return;
        const page = await pdfDoc.getPage(p);
        const viewport = page.getViewport({ scale: 1.5 });
        sizes.push({ width: viewport.width, height: viewport.height });
        const canvas = canvasRefs.current[p];
        if (!canvas) continue;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
      if (!cancelled) setPageSizes(sizes);
    })();

    return () => { cancelled = true; };
  }, [pdfDoc]);

  // ── 3. Click on page → add field ──────────────────────────────────────────
  const handlePageClick = useCallback((e, pageNum) => {
    if (!activeSigner) {
      setError('Choose a signer first.');
      return;
    }
    // Only add if click was on the page wrapper (not on an existing field).
    if (e.target.dataset?.field === '1') return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width)  * 100;
    const y = ((e.clientY - rect.top)  / rect.height) * 100;
    const size = DEFAULT_SIZES[activeTool];

    const newField = {
      tempId:      `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      signer_id:   activeSigner,
      field_type:  activeTool,
      page_number: pageNum,
      x_pct:       Math.max(0, Math.min(100 - size.w, x - size.w / 2)),
      y_pct:       Math.max(0, Math.min(100 - size.h, y - size.h / 2)),
      width_pct:   size.w,
      height_pct:  size.h,
      required:    true,
    };
    setFields(prev => [...prev, newField]);
    setSelectedId(newField.tempId);
    setError('');
  }, [activeSigner, activeTool]);

  // ── 4. Drag a placed field ────────────────────────────────────────────────
  const startDrag = (e, tempId) => {
    e.stopPropagation();
    setSelectedId(tempId);
    const field = fields.find(f => f.tempId === tempId);
    if (!field) return;
    const pageEl = e.currentTarget.parentElement;
    const pageRect = pageEl.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX  = field.x_pct;
    const origY  = field.y_pct;

    const onMove = (me) => {
      const dx = ((me.clientX - startX) / pageRect.width)  * 100;
      const dy = ((me.clientY - startY) / pageRect.height) * 100;
      setFields(prev => prev.map(f => f.tempId === tempId
        ? {
            ...f,
            x_pct: Math.max(0, Math.min(100 - f.width_pct,  origX + dx)),
            y_pct: Math.max(0, Math.min(100 - f.height_pct, origY + dy)),
          }
        : f));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const removeField = (tempId) => {
    setFields(prev => prev.filter(f => f.tempId !== tempId));
    if (selectedId === tempId) setSelectedId(null);
  };

  // Keyboard: Delete removes selected
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        removeField(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // ── 5. Save & dispatch ────────────────────────────────────────────────────
  const save = async (dispatch) => {
    setError('');
    if (fields.length === 0) {
      setError('Add at least one field before saving.');
      return;
    }
    // Require every signer has ≥1 field
    const signerIdsWithFields = new Set(fields.map(f => f.signer_id));
    const missing = signers.filter(s => !signerIdsWithFields.has(s.id));
    if (missing.length > 0) {
      setError(`Each signer needs at least one field. Missing: ${missing.map(s => s.email).join(', ')}`);
      return;
    }

    setSaving(true);
    try {
      const payload = fields.map(({ tempId, ...rest }) => rest);
      await api.post(`/fields/${id}`, { fields: payload });

      if (dispatch) {
        await api.post(`/signers/${id}/dispatch`, {});
      }
      navigate('/manage');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save fields.');
    } finally {
      setSaving(false);
    }
  };

  const colorFor = useCallback((signerId) => {
    const idx = signers.findIndex(s => s.id === signerId);
    return SIGNER_COLORS[idx % SIGNER_COLORS.length] || '#2563eb';
  }, [signers]);

  const fieldCountBySigner = useMemo(() => {
    const map = {};
    for (const f of fields) map[f.signer_id] = (map[f.signer_id] || 0) + 1;
    return map;
  }, [fields]);

  if (loading) {
    return (
      <AppShell>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={s.spinner} />
            <p style={{ color: '#64748b', marginTop: '1rem' }}>Loading document…</p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (error && !pdfDoc) {
    return (
      <AppShell>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fee2e2', color: '#dc2626', padding: '1rem 1.5rem', borderRadius: 8 }}>
            {error}
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', background: '#e2e8f0', minHeight: 0 }}>

        {/* ── SIDEBAR ──────────────────────────────────────────────────── */}
        <aside style={s.sidebar}>
          <div style={s.sidebarSection}>
            <div style={s.sectionLabel}>Document</div>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {docInfo?.original_name || '—'}
            </div>
            <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: 2 }}>
              {pageCount} page{pageCount !== 1 ? 's' : ''}
            </div>
          </div>

          <div style={s.sidebarSection}>
            <div style={s.sectionLabel}>Signers — click to assign next field</div>
            {signers.map((sg, i) => {
              const color = SIGNER_COLORS[i % SIGNER_COLORS.length];
              const isActive = activeSigner === sg.id;
              const count = fieldCountBySigner[sg.id] || 0;
              return (
                <button key={sg.id} onClick={() => setActiveSigner(sg.id)}
                  style={{
                    ...s.signerBtn,
                    borderColor: isActive ? color : '#e5e7eb',
                    background:  isActive ? `${color}18` : 'white',
                  }}>
                  <span style={{ ...s.signerDot, background: color }}>{i + 1}</span>
                  <span style={s.signerEmail}>{sg.email}</span>
                  <span style={{ ...s.signerBadge, background: count > 0 ? color : '#e5e7eb', color: count > 0 ? 'white' : '#94a3b8' }}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={s.sidebarSection}>
            <div style={s.sectionLabel}>Field type</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
              {Object.keys(FIELD_LABELS).map(tool => (
                <button key={tool} onClick={() => setActiveTool(tool)}
                  style={{
                    ...s.toolBtn,
                    borderColor: activeTool === tool ? '#2563eb' : '#e5e7eb',
                    background:  activeTool === tool ? '#eff6ff' : 'white',
                    color:       activeTool === tool ? '#2563eb' : '#374151',
                  }}>
                  <div style={{ fontSize: '1.1rem' }}>{FIELD_ICONS[tool]}</div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 600, marginTop: 2 }}>{FIELD_LABELS[tool]}</div>
                </button>
              ))}
            </div>
          </div>

          <div style={s.sidebarSection}>
            <div style={s.sectionLabel}>Tip</div>
            <p style={{ fontSize: '0.75rem', color: '#64748b', lineHeight: 1.45, margin: 0 }}>
              Select a signer and a field type, then click anywhere on the document to place it. Drag to reposition. Press <kbd style={s.kbd}>Del</kbd> to remove.
            </p>
          </div>

          <div style={{ ...s.sidebarSection, borderBottom: 'none', marginTop: 'auto' }}>
            {error && (
              <div style={{ fontSize: '0.78rem', color: '#dc2626', background: '#fee2e2', padding: '0.5rem 0.7rem', borderRadius: 6, marginBottom: '0.6rem' }}>
                {error}
              </div>
            )}
            <button onClick={() => save(false)} disabled={saving}
              style={{ ...s.btnSecondary, width: '100%', marginBottom: '0.5rem' }}>
              Save draft
            </button>
            <button onClick={() => save(true)} disabled={saving}
              style={{ ...s.btnPrimary, width: '100%' }}>
              {saving ? 'Saving…' : 'Save & Send →'}
            </button>
            <button onClick={() => navigate('/manage')} disabled={saving}
              style={{ ...s.btnGhost, width: '100%', marginTop: '0.5rem' }}>
              Cancel
            </button>
          </div>
        </aside>

        {/* ── PDF PAGES ────────────────────────────────────────────────── */}
        <main style={{ flex: 1, overflow: 'auto', padding: '1.5rem' }}>
          <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {Array.from({ length: pageCount }, (_, i) => i + 1).map(pageNum => (
              <div key={pageNum} style={{ position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.12)', background: 'white', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}
                     onClick={(e) => handlePageClick(e, pageNum)}>
                  <canvas
                    ref={el => { if (el) canvasRefs.current[pageNum] = el; }}
                    style={{ display: 'block', width: '100%', height: 'auto', cursor: activeSigner ? 'crosshair' : 'not-allowed' }}
                  />
                  {/* Field overlays on this page */}
                  {fields.filter(f => f.page_number === pageNum).map(f => {
                    const color = colorFor(f.signer_id);
                    const isSel = selectedId === f.tempId;
                    return (
                      <div key={f.tempId}
                           data-field="1"
                           onMouseDown={(e) => startDrag(e, f.tempId)}
                           onClick={(e) => { e.stopPropagation(); setSelectedId(f.tempId); }}
                           style={{
                             position: 'absolute',
                             left:   `${f.x_pct}%`,
                             top:    `${f.y_pct}%`,
                             width:  `${f.width_pct}%`,
                             height: `${f.height_pct}%`,
                             background:  `${color}26`,
                             border:      `${isSel ? 2 : 1.5}px dashed ${color}`,
                             borderRadius: 3,
                             display: 'flex', alignItems: 'center', justifyContent: 'center',
                             fontSize: '0.68rem', fontWeight: 700, color,
                             cursor: 'move',
                             userSelect: 'none',
                             boxSizing: 'border-box',
                           }}>
                        <span data-field="1" style={{ pointerEvents: 'none' }}>
                          {FIELD_ICONS[f.field_type]} {FIELD_LABELS[f.field_type]}
                        </span>
                        {isSel && (
                          <button data-field="1"
                                  onClick={(e) => { e.stopPropagation(); removeField(f.tempId); }}
                                  style={{
                                    position: 'absolute', top: -10, right: -10,
                                    width: 20, height: 20, borderRadius: '50%',
                                    background: '#dc2626', color: 'white',
                                    border: 'none', cursor: 'pointer',
                                    fontSize: '0.7rem', fontWeight: 700,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  }}>×</button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 600 }}>
                  Page {pageNum}
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AppShell>
  );
}

const s = {
  spinner: { width: 40, height: 40, border: '3px solid #e5e7eb', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' },
  sidebar: { width: 300, flexShrink: 0, background: 'white', borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', overflow: 'auto' },
  sidebarSection: { padding: '1rem 1.25rem', borderBottom: '1px solid #f1f5f9' },
  sectionLabel: { fontSize: '0.68rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.6rem' },
  signerBtn: { width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.55rem 0.6rem', borderRadius: 8, border: '1.5px solid', cursor: 'pointer', marginBottom: '0.4rem', textAlign: 'left' },
  signerDot: { width: 20, height: 20, borderRadius: '50%', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.68rem', fontWeight: 700, flexShrink: 0 },
  signerEmail: { flex: 1, fontSize: '0.78rem', color: '#0f172a', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  signerBadge: { minWidth: 22, padding: '0 6px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 700, textAlign: 'center' },
  toolBtn: { padding: '0.5rem 0.3rem', borderRadius: 8, border: '1.5px solid', cursor: 'pointer', textAlign: 'center' },
  kbd: { background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: 3, padding: '0 4px', fontSize: '0.7rem' },
  btnPrimary:   { padding: '0.65rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' },
  btnSecondary: { padding: '0.6rem', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 8, fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' },
  btnGhost:     { padding: '0.5rem', background: 'transparent', color: '#64748b', border: 'none', fontSize: '0.8rem', cursor: 'pointer' },
};
