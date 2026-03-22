export const S = {
  app: {
    minHeight: '100vh', background: '#0e1117', color: '#e6edf3',
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    display: 'flex', flexDirection: 'column', position: 'relative',
  },

  // Header
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 20px', borderBottom: '1px solid #2a3040',
    background: '#161b22', flexWrap: 'wrap', gap: 8,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  title: { fontSize: 16, fontWeight: 700, margin: 0 },
  badge: {
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em',
    color: '#7ee787', background: 'rgba(126,231,135,.12)',
    padding: '2px 7px', borderRadius: 3,
  },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  select: {
    padding: '6px 10px', background: '#1c2129', color: '#e6edf3',
    border: '1px solid #2a3040', borderRadius: 6, fontSize: 11,
    fontFamily: 'inherit', cursor: 'pointer', outline: 'none',
  },
  ghostBtn: {
    padding: '6px 12px', background: 'transparent', color: '#7d8590',
    border: '1px solid #2a3040', borderRadius: 6, fontWeight: 600,
    fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
  },
  captureGroup: { display: 'flex', gap: 0 },
  captureBtn: {
    padding: '7px 14px', background: '#58a6ff', color: '#0e1117',
    border: 'none', borderRadius: '6px 0 0 6px', fontWeight: 700,
    fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
    display: 'flex', alignItems: 'center',
  },
  uploadBtn: {
    padding: '7px 14px', background: '#3a7bd5', color: '#0e1117',
    border: 'none', borderRadius: '0 6px 6px 0', fontWeight: 700,
    fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
    borderLeft: '1px solid rgba(14,17,23,.3)',
  },
  kbd: {
    fontSize: 10, color: '#7d8590', background: '#1c2129',
    border: '1px solid #2a3040', borderRadius: 4, padding: '3px 8px',
    fontFamily: 'inherit',
  },
  kbdInline: {
    fontSize: '0.85em', color: '#7d8590', background: '#1c2129',
    border: '1px solid #2a3040', borderRadius: 3, padding: '1px 5px',
    fontFamily: 'inherit',
  },

  // API Key bar
  keyBar: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 20px',
    background: '#1c2129', borderBottom: '1px solid #2a3040', flexWrap: 'wrap',
  },
  keyLabel: { fontSize: 12, color: '#7d8590', fontWeight: 600 },
  keyInput: {
    flex: 1, minWidth: 200, padding: '6px 10px', background: '#0e1117',
    color: '#e6edf3', border: '1px solid #2a3040', borderRadius: 6,
    fontSize: 12, fontFamily: 'inherit', outline: 'none',
  },
  getKeyLink: {
    padding: '6px 12px', background: 'rgba(88,166,255,.12)', color: '#58a6ff',
    border: '1px solid rgba(88,166,255,.25)', borderRadius: 6, fontWeight: 600,
    fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'none',
    whiteSpace: 'nowrap',
  },
  keyDone: {
    padding: '6px 14px', background: '#58a6ff', color: '#0e1117',
    border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 12,
    fontFamily: 'inherit', cursor: 'pointer',
  },

  // Main
  main: { flex: 1, padding: 20, overflow: 'auto' },

  // Empty state
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', minHeight: '65vh', textAlign: 'center',
  },
  emptyTitle: { fontSize: 22, fontWeight: 600, margin: '0 0 10px' },
  emptyDesc: {
    fontSize: 13, color: '#7d8590', maxWidth: 520, lineHeight: 1.7, margin: 0,
  },
  methods: { display: 'flex', gap: 14, marginTop: 28, flexWrap: 'wrap', justifyContent: 'center' },
  methodCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    padding: '18px 28px', borderRadius: 10, border: '1px solid',
    background: '#161b22', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
  },

  // Error
  errorBar: {
    background: 'rgba(248,81,73,.1)', border: '1px solid #f85149',
    color: '#f85149', padding: '12px 16px', borderRadius: 6,
    fontSize: 13, marginBottom: 16,
  },
  errorActions: {
    display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap',
  },
  errorLink: {
    padding: '6px 14px', background: '#f85149', color: '#fff',
    borderRadius: 6, fontWeight: 700, fontSize: 12, textDecoration: 'none',
    fontFamily: 'inherit',
  },
  errorSwitchBtn: {
    padding: '6px 12px', background: 'transparent', color: '#7d8590',
    border: '1px solid #2a3040', borderRadius: 6, fontWeight: 600,
    fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
  },

  // Progress
  progressBar: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
    background: '#161b22', border: '1px solid #2a3040', borderRadius: 8, marginBottom: 12,
  },
  progressDot: {
    width: 12, height: 12, borderRadius: '50%', background: '#58a6ff',
    animation: 'pulse 1.5s ease infinite', flexShrink: 0,
  },
  progressText: { fontSize: 12, color: '#7d8590' },

  // Image
  imageContainer: {
    position: 'relative', borderRadius: 10, overflow: 'hidden',
    border: '1px solid #2a3040', cursor: 'pointer', background: '#000',
    display: 'inline-block', maxWidth: '100%', margin: '0 auto',
  },
  mainImage: { display: 'block', maxWidth: '100%', maxHeight: '75vh', height: 'auto', width: 'auto' },
  overlayLayer: { position: 'absolute', inset: 0 },
  capturedOverlay: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(14,17,23,.55)',
    backdropFilter: 'blur(2px)',
  },
  bigBtn: {
    display: 'flex', alignItems: 'center', padding: '16px 36px',
    background: '#d2a8ff', color: '#0e1117', border: 'none', borderRadius: 8,
    fontWeight: 700, fontSize: 16, fontFamily: 'inherit', cursor: 'pointer',
    boxShadow: '0 4px 24px rgba(210,168,255,.3)',
  },
  hint: {
    position: 'absolute', bottom: 12, right: 12,
    background: 'rgba(14,17,23,.85)', color: '#7d8590',
    padding: '6px 12px', borderRadius: 6, fontSize: 11,
    display: 'flex', alignItems: 'center', gap: 6,
    border: '1px solid #2a3040', pointerEvents: 'none',
  },

  // Stats
  stats: { display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' },
  stat: {
    fontSize: 11, color: '#7d8590', background: '#161b22',
    border: '1px solid #2a3040', padding: '4px 10px', borderRadius: 4,
  },

  // Expanded
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(2,4,8,.94)', backdropFilter: 'blur(8px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24, cursor: 'pointer', animation: 'fadeIn .2s ease', overflow: 'auto',
  },
  closeBadge: {
    position: 'fixed', top: 16, right: 20, zIndex: 1010,
    color: '#7d8590', fontSize: 13, display: 'flex', alignItems: 'center',
    fontFamily: "'JetBrains Mono', monospace",
  },
  expandedWrap: {
    position: 'relative', maxWidth: '95vw', maxHeight: '92vh',
    cursor: 'default', borderRadius: 8, overflow: 'hidden',
    boxShadow: '0 16px 64px rgba(0,0,0,.6)',
  },
  expandedImg: {
    display: 'block', maxWidth: '95vw', maxHeight: '92vh', objectFit: 'contain',
  },

  // Tooltip
  tooltip: {
    position: 'fixed', transform: 'translate(-50%, -100%)',
    background: '#1c2129', border: '1px solid #2a3040',
    borderRadius: 10, padding: '12px 16px', zIndex: 9999,
    boxShadow: '0 12px 40px rgba(0,0,0,.6)',
    minWidth: 170, maxWidth: 300, pointerEvents: 'none',
    animation: 'fadeUp .12s ease',
    fontFamily: "'JetBrains Mono', monospace",
  },
  tooltipBackdrop: {
    position: 'fixed', inset: 0, zIndex: 9998,
    background: 'rgba(2,4,8,.35)',
  },
  tooltipExpanded: {
    position: 'fixed', left: '50%', top: '50%',
    transform: 'translate(-50%, -50%)',
    maxWidth: 900, width: '92vw', maxHeight: '85vh',
    overflowY: 'auto', pointerEvents: 'auto',
    borderRadius: 12, padding: '24px 32px',
    boxShadow: '0 24px 80px rgba(0,0,0,.8)',
    border: '1px solid #3a4050',
  },
  ttWord: { fontSize: 17, fontWeight: 700, color: '#e6edf3', marginBottom: 2 },
  ttTrans: { fontSize: 14, color: '#58a6ff', fontWeight: 500, marginBottom: 8 },
  ttEng: {
    fontSize: 11, color: '#7ee787', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8,
  },
  ttSynWrap: { borderTop: '1px solid #2a3040', paddingTop: 8 },
  ttSynLabel: {
    fontSize: 9, textTransform: 'uppercase', letterSpacing: '.1em',
    color: '#7d8590', marginBottom: 6, fontWeight: 600,
  },
  ttSynList: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  ttSynChip: {
    fontSize: 11, background: 'rgba(88,166,255,.12)', color: '#58a6ff',
    padding: '3px 8px', borderRadius: 4, fontWeight: 500,
  },
  ttConf: {
    fontSize: 10, color: '#7d8590', marginTop: 8,
    borderTop: '1px solid #2a3040', paddingTop: 6,
  },
  ttClose: {
    fontSize: 18, color: '#7d8590', cursor: 'pointer', lineHeight: 1,
    padding: '0 2px', marginLeft: 8,
  },
  ttClickHint: {
    fontSize: 10, color: '#484f58', marginTop: 8,
    borderTop: '1px solid #2a3040', paddingTop: 6, textAlign: 'center',
  },
  ttActions: {
    marginTop: 8, borderTop: '1px solid #2a3040', paddingTop: 8,
  },
  ttExplainBtn: {
    display: 'flex', alignItems: 'center', width: '100%',
    padding: '7px 12px', background: 'rgba(88,166,255,.12)', color: '#58a6ff',
    border: '1px solid rgba(88,166,255,.25)', borderRadius: 6,
    fontWeight: 600, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
    justifyContent: 'center',
  },
  ttExplaining: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 11, color: '#7d8590',
  },
  ttExplainingDot: {
    width: 8, height: 8, borderRadius: '50%', background: '#58a6ff',
    animation: 'pulse 1.5s ease infinite', flexShrink: 0,
  },
  ttExplanation: {
    fontSize: 14, color: '#c9d1d9', lineHeight: 1.7,
    background: 'rgba(88,166,255,.06)', borderRadius: 6,
    padding: '10px 14px', marginTop: 6,
  },
  ttBtnRow: {
    display: 'flex', gap: 6, marginTop: 8,
  },
  ttDeepBtn: {
    flex: 1, padding: '7px 10px', background: 'rgba(210,168,255,.12)', color: '#d2a8ff',
    border: '1px solid rgba(210,168,255,.25)', borderRadius: 6,
    fontWeight: 600, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
    textAlign: 'center',
  },
  ttStudyBtn: {
    flex: 1, padding: '7px 10px', background: 'rgba(126,231,135,.12)', color: '#7ee787',
    border: '1px solid rgba(126,231,135,.25)', borderRadius: 6,
    fontWeight: 600, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
    textAlign: 'center',
  },
  ttDeepExplanation: {
    fontSize: 14, color: '#c9d1d9', lineHeight: 1.8, whiteSpace: 'pre-wrap',
    background: 'rgba(210,168,255,.04)', border: '1px solid rgba(210,168,255,.12)',
    borderRadius: 8, padding: '14px 18px', marginTop: 8,
  },
  ttWordStudy: {
    marginTop: 8, border: '1px solid rgba(126,231,135,.2)',
    borderRadius: 8, overflow: 'hidden',
  },
  ttWordStudyHeader: {
    fontSize: 12, fontWeight: 700, color: '#7ee787',
    background: 'rgba(126,231,135,.08)', padding: '8px 10px',
    borderBottom: '1px solid rgba(126,231,135,.15)',
  },
  ttWordStudyBody: {
    padding: '14px 16px', background: 'rgba(126,231,135,.03)',
  },
  ttChatSection: {
    marginTop: 8, borderTop: '1px solid #2a3040', paddingTop: 8,
  },
  ttChatLabel: {
    fontSize: 9, textTransform: 'uppercase', letterSpacing: '.1em',
    color: '#7d8590', marginBottom: 6, fontWeight: 600,
  },
  ttChatUser: {
    fontSize: 12, color: '#e6edf3', background: 'rgba(88,166,255,.1)',
    borderRadius: 6, padding: '6px 10px', marginBottom: 4, textAlign: 'right',
  },
  ttChatAssistant: {
    fontSize: 12, color: '#c9d1d9', background: 'rgba(126,231,135,.06)',
    borderRadius: 6, padding: '6px 10px', marginBottom: 4, lineHeight: 1.5,
  },
  ttChatInputRow: {
    display: 'flex', gap: 4, marginTop: 4,
  },
  ttChatInput: {
    flex: 1, padding: '6px 8px', background: '#0e1117', color: '#e6edf3',
    border: '1px solid #2a3040', borderRadius: 6, fontSize: 11,
    fontFamily: 'inherit', outline: 'none',
  },
  ttChatSend: {
    padding: '6px 10px', background: '#58a6ff', color: '#0e1117',
    border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 11,
    fontFamily: 'inherit', cursor: 'pointer',
  },

  // Drag overlay
  dragOverlay: {
    position: 'fixed', inset: 0, zIndex: 100,
    background: 'rgba(14,17,23,.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  dragBox: {
    border: '2px dashed #58a6ff', borderRadius: 16,
    padding: '48px 64px', display: 'flex',
    flexDirection: 'column', alignItems: 'center',
  },
}
