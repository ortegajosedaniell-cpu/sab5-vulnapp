/* ═══════════════════════════════════════════════════════════════
   SecureReport – app.js
   Wizard paso a paso + generación por IA
═══════════════════════════════════════════════════════════════ */

// ── Estado global ─────────────────────────────────────────────
const State = {
  token:   localStorage.getItem('sr_token') || null,
  user:    JSON.parse(localStorage.getItem('sr_user') || 'null'),
  reports: [],
  // Wizard
  wizard: {
    step: 1,
    totalSteps: 6,
    data: {}   // acumula todos los datos del informe
  },
  selectedFiles: [],  // fotos globales (paso 5)
  areaPhotos:    {},  // fotos por hallazgo { areaKey: [File, ...] }
  editingReportId: null,
};

// ── API helper ────────────────────────────────────────────────
async function api(method, path, data = null, isFormData = false) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${State.token}` },
  };
  if (data && !isFormData) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  if (data && isFormData) opts.body = data;

  const res  = await fetch(`/api${path}`, opts);
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
  return json;
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, type = 'default') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, 3200);
}

// ── Helpers ───────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d)) return str;
  return d.toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function calcRiskLevel(score) {
  if (score <= 5)  return 'Bajo';
  if (score <= 10) return 'Medio';
  if (score <= 15) return 'Alto';
  return 'Crítico';
}

function riskClass(level) {
  return { 'Crítico': 'critico', 'Alto': 'alto', 'Medio': 'medio', 'Bajo': 'bajo' }[level] || 'bajo';
}

function badgeHtml(level) {
  const cls   = riskClass(level);
  const icons = { critico: '🔴', alto: '🟠', medio: '🔵', bajo: '🟢' };
  return `<span class="badge badge-${cls}">${icons[cls] || ''} ${level}</span>`;
}

// ════════════════════════════════════════════════════════════════
//  LOGIN
// ════════════════════════════════════════════════════════════════
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn  = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Ingresando...';
  errEl.classList.add('hidden');

  try {
    const { token, user } = await api('POST', '/auth/login', {
      username: document.getElementById('login-user').value.trim(),
      password: document.getElementById('login-pass').value,
    });
    State.token = token;
    State.user  = user;
    localStorage.setItem('sr_token', token);
    localStorage.setItem('sr_user', JSON.stringify(user));
    initApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Ingresar al sistema';
  }
});

// ── Auto-login ────────────────────────────────────────────────
if (State.token && State.user) {
  api('GET', '/auth/me').then(() => initApp()).catch(() => {
    localStorage.clear(); State.token = null; State.user = null;
  });
}

// ── Logout ────────────────────────────────────────────────────
document.getElementById('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('sr_token');
  localStorage.removeItem('sr_user');
  location.reload();
});

// ════════════════════════════════════════════════════════════════
//  INIT APP
// ════════════════════════════════════════════════════════════════
function initApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
  document.getElementById('nav-username').textContent = State.user.full_name;
  document.getElementById('nav-role-badge').textContent =
    State.user.role === 'admin' ? 'ADMIN' : 'SUPERVISOR';

  if (State.user.role === 'admin') {
    document.getElementById('btn-tab-admin').classList.remove('hidden');
    document.getElementById('btn-export-csv').classList.remove('hidden');
    document.getElementById('filter-supervisor').classList.remove('hidden');
    populateSupervisorFilter();
  }

  initTabs();
  loadReports();
  if (State.user.role === 'admin') buildAdminPanel();
}

// ── Tabs ──────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(`tab-${target}`).classList.remove('hidden');

      if (target === 'new-report') {
        if (!State.editingReportId) resetWizard();
        renderWizard();
      }
    });
  });
}

function goToTab(name) {
  document.querySelectorAll('.tab-btn[data-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById(`tab-${name}`).classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  DEFINICIÓN DE ÁREAS
// ════════════════════════════════════════════════════════════════
const AREAS = [
  { key: 'iluminacion',    icon: '💡', label: 'Iluminación' },
  { key: 'perimetro',      icon: '🚧', label: 'Perímetro' },
  { key: 'accesos',        icon: '🚪', label: 'Accesos' },
  { key: 'camaras',        icon: '📷', label: 'CCTV' },
  { key: 'cerraduras',     icon: '🔐', label: 'Cerraduras' },
  { key: 'guardias',       icon: '👮', label: 'Guardias' },
  { key: 'comunicaciones', icon: '📡', label: 'Comunicaciones' },
  { key: 'materiales',     icon: '⚠️',  label: 'Materiales' },
  { key: 'emergencias',    icon: '🔴', label: 'Emergencias' },
  { key: 'vehiculos',      icon: '🚗', label: 'Vehicular' },
];

const SERVICE_TYPES = [
  'Objetivo fijo', 'Recorrido', 'Obrador / Obra',
  'Eventos', 'Escolta', 'Depósito / Logística',
  'Bancos / Financiero', 'Industrial', 'Residencial', 'Otro',
];

const SEV_LABELS = ['', 'Leve', 'Moderada', 'Significativa', 'Grave'];
const PROB_LABELS = ['', 'Rara', 'Ocasional', 'Moderada', 'Probable', 'Casi segura'];
const IMP_LABELS  = ['', 'Mínimo', 'Menor', 'Moderado', 'Mayor', 'Catastrófico'];

// ════════════════════════════════════════════════════════════════
//  WIZARD: estado y reset
// ════════════════════════════════════════════════════════════════
function resetWizard() {
  const now = new Date();
  const localISO = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);

  State.editingReportId = null;
  State.selectedFiles   = [];
  State.areaPhotos      = {};
  State.wizard = {
    step: 1,
    totalSteps: 6,
    data: {
      client: '', address: '', service_type: '', report_date: localISO,
      areas: {},           // { key: { affected: bool, severity: 1-4, findings: '' } }
      probability: 3,
      impact: 3,
      extra_notes: '',
      descripcion: '',
      recomendaciones: '',
    }
  };
}

// ════════════════════════════════════════════════════════════════
//  RENDER WIZARD
// ════════════════════════════════════════════════════════════════
const STEP_LABELS = ['Servicio', 'Áreas', 'Hallazgos', 'Riesgo', 'Fotos', 'IA'];

function renderWizard() {
  const container = document.getElementById('report-form-container');
  const { step, totalSteps, data } = State.wizard;

  // Barra de progreso
  const stepsHtml = STEP_LABELS.map((label, i) => {
    const n = i + 1;
    let cls = '';
    if (n < step)  cls = 'done';
    if (n === step) cls = 'active';
    const dotContent = n < step ? '✓' : n;
    return `
      <div class="wizard-step-dot ${cls}">
        <div class="dot">${dotContent}</div>
        <div class="dot-label">${label}</div>
      </div>`;
  }).join('');

  let screenHtml = '';
  if (step === 1) screenHtml = renderStep1(data);
  if (step === 2) screenHtml = renderStep2(data);
  if (step === 3) screenHtml = renderStep3(data);
  if (step === 4) screenHtml = renderStep4(data);
  if (step === 5) screenHtml = renderStep5(data);
  if (step === 6) screenHtml = renderStep6(data);

  container.innerHTML = `
    <div class="wizard-progress">
      <div class="wizard-steps">${stepsHtml}</div>
    </div>
    <div class="wizard-screen" id="wizard-screen">
      ${screenHtml}
    </div>`;

  bindStepEvents(step);
}

// ── PASO 1: Datos del servicio ────────────────────────────────
function renderStep1(d) {
  return `
    <div class="card">
      <div class="wizard-screen-title">📌 Datos del Servicio</div>
      <div class="wizard-screen-subtitle">Completá los datos básicos del lugar inspeccionado.</div>

      <div class="form-group">
        <label class="form-label">Cliente / Empresa <span class="required">*</span></label>
        <input id="w-client" class="form-input" type="text"
               placeholder="Nombre del cliente" value="${escHtml(d.client)}" required>
      </div>

      <div class="form-group">
        <label class="form-label">Dirección del servicio <span class="required">*</span></label>
        <input id="w-address" class="form-input" type="text"
               placeholder="Dirección completa" value="${escHtml(d.address)}" required>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Tipo de servicio <span class="required">*</span></label>
          <select id="w-service" class="form-select">
            <option value="">Seleccionar...</option>
            ${SERVICE_TYPES.map(t =>
              `<option value="${t}" ${d.service_type === t ? 'selected' : ''}>${t}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Fecha y hora</label>
          <input id="w-date" class="form-input" type="datetime-local"
                 value="${d.report_date}">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Supervisor a cargo</label>
        <input class="form-input" type="text"
               value="${escHtml(State.user.full_name)}" disabled
               style="background:var(--gray-100);color:var(--gray-600);">
      </div>

      <div class="wizard-nav">
        <button class="btn btn-primary" id="step1-next">Siguiente →</button>
      </div>
    </div>`;
}

// ── PASO 2: Selección de áreas ────────────────────────────────
function renderStep2(d) {
  const cardsHtml = AREAS.map(area => {
    const state = d.areas[area.key];
    let cls = '', statusText = 'Tocá para evaluar';
    if (state !== undefined) {
      cls        = state.affected ? 'vuln' : 'ok';
      statusText = state.affected ? '⚠ Con vulnerabilidad' : '✓ Sin novedad';
    }
    return `
      <div class="area-card ${cls}" data-key="${area.key}" id="area-${area.key}">
        <div class="area-icon">${area.icon}</div>
        <div class="area-label">${area.label}</div>
        <div class="area-status">${statusText}</div>
      </div>`;
  }).join('');

  const evaluated = Object.keys(d.areas).length;

  return `
    <div class="card">
      <div class="wizard-screen-title">🔍 Evaluación de Áreas</div>
      <div class="wizard-screen-subtitle">
        Tocá cada área: <strong>una vez</strong> = sin novedad · <strong>dos veces</strong> = vulnerabilidad.
        <br>Evaluadas: <strong>${evaluated} / ${AREAS.length}</strong>
      </div>

      <div class="area-grid">${cardsHtml}</div>

      <div class="wizard-nav">
        <button class="btn btn-ghost" id="step-prev">← Atrás</button>
        <button class="btn btn-primary" id="step2-next">Siguiente →</button>
      </div>
    </div>`;
}

// ── PASO 3: Hallazgos por área vulnerable ─────────────────────
function renderStep3(d) {
  const vulnAreas = AREAS.filter(a => d.areas[a.key]?.affected);

  if (!vulnAreas.length) {
    return `
      <div class="card">
        <div class="wizard-screen-title">✅ Sin vulnerabilidades</div>
        <div class="wizard-screen-subtitle">
          No marcaste áreas vulnerables. Podés volver atrás o continuar.
        </div>
        <div class="form-group">
          <label class="form-label">Notas generales (opcional)</label>
          <textarea id="w-extra-notes" class="form-textarea" rows="3"
            placeholder="Observaciones adicionales...">${escHtml(d.extra_notes)}</textarea>
        </div>
        <div class="wizard-nav">
          <button class="btn btn-ghost" id="step-prev">← Atrás</button>
          <button class="btn btn-primary" id="step3-next">Siguiente →</button>
        </div>
      </div>`;
  }

  const findingsHtml = vulnAreas.map(area => {
    const aData  = d.areas[area.key];
    const sev    = aData?.severity || 2;
    const photos = State.areaPhotos[area.key] || [];
    const photoPreviews = photos.map((f, idx) => `
      <div class="fp-item">
        <img src="${URL.createObjectURL(f)}" alt="foto">
        <button type="button" class="fp-remove" data-area="${area.key}" data-idx="${idx}">✕</button>
      </div>`).join('');

    return `
      <div class="finding-card">
        <div class="finding-card-title">${area.icon} ${area.label}</div>

        <label class="form-label text-xs">Gravedad:</label>
        <div class="severity-buttons">
          ${['Leve','Moderada','Significativa','Grave'].map((s,i) => `
            <button type="button"
                    class="sev-btn ${sev === i+1 ? 'active-'+(i+1) : ''}"
                    data-area="${area.key}" data-sev="${i+1}">${s}</button>
          `).join('')}
        </div>

        <label class="form-label text-xs">Descripción del hallazgo:</label>
        <textarea class="form-textarea finding-text"
                  data-area="${area.key}"
                  rows="2"
                  placeholder="Describí la falla o condición insegura observada...">${escHtml(aData?.findings || '')}</textarea>

        <div class="fp-section">
          <div class="fp-list" id="fp-list-${area.key}">${photoPreviews}</div>
          <label class="fp-add-btn" for="fp-input-${area.key}">
            📷 ${photos.length ? `${photos.length} foto(s)` : 'Agregar foto'}
            <input type="file" id="fp-input-${area.key}" class="fp-input"
                   data-area="${area.key}" accept="image/*" capture="environment" multiple style="display:none;">
          </label>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="card">
      <div class="wizard-screen-title">📝 Detallá los Hallazgos</div>
      <div class="wizard-screen-subtitle">
        Para cada área vulnerable, indicá la gravedad y describí brevemente lo observado.
      </div>

      ${findingsHtml}

      <div class="form-group">
        <label class="form-label">Notas adicionales (opcional)</label>
        <textarea id="w-extra-notes" class="form-textarea" rows="2"
          placeholder="Cualquier observación extra...">${escHtml(d.extra_notes)}</textarea>
      </div>

      <div class="wizard-nav">
        <button class="btn btn-ghost" id="step-prev">← Atrás</button>
        <button class="btn btn-primary" id="step3-next">Siguiente →</button>
      </div>
    </div>`;
}

// ── PASO 4: Evaluación de riesgo ──────────────────────────────
function renderStep4(d) {
  const score    = d.probability * d.impact;
  const level    = calcRiskLevel(score);
  const levelKey = riskClass(level);

  return `
    <div class="card">
      <div class="wizard-screen-title">⚠️ Evaluación de Riesgo</div>
      <div class="wizard-screen-subtitle">
        Ajustá la probabilidad e impacto. El nivel se calcula automáticamente.
      </div>

      <div class="risk-visual-grid">
        <div class="risk-visual-box">
          <div class="rvb-label">Probabilidad</div>
          <div class="rvb-value" id="prob-display">${d.probability}</div>
          <div class="rvb-desc" id="prob-label-display">${PROB_LABELS[d.probability]}</div>
        </div>
        <div class="risk-visual-box">
          <div class="rvb-label">Impacto</div>
          <div class="rvb-value" id="impact-display">${d.impact}</div>
          <div class="rvb-desc" id="impact-label-display">${IMP_LABELS[d.impact]}</div>
        </div>
      </div>

      <div class="form-group">
        <div class="slider-label">
          <label class="form-label" style="margin:0">Probabilidad de ocurrencia</label>
          <span class="slider-value" id="prob-val">${d.probability}</span>
        </div>
        <input type="range" id="w-probability" min="1" max="5" value="${d.probability}" step="1">
        <div style="display:flex;justify-content:space-between;font-size:.7rem;color:var(--gray-400);margin-top:4px;">
          <span>Rara</span><span>Ocasional</span><span>Moderada</span><span>Probable</span><span>Casi segura</span>
        </div>
      </div>

      <div class="form-group mt-3">
        <div class="slider-label">
          <label class="form-label" style="margin:0">Impacto potencial</label>
          <span class="slider-value" id="impact-val">${d.impact}</span>
        </div>
        <input type="range" id="w-impact" min="1" max="5" value="${d.impact}" step="1">
        <div style="display:flex;justify-content:space-between;font-size:.7rem;color:var(--gray-400);margin-top:4px;">
          <span>Mínimo</span><span>Menor</span><span>Moderado</span><span>Mayor</span><span>Catastrófico</span>
        </div>
      </div>

      <div class="risk-result ${levelKey} mt-3" id="risk-result-box">
        <div class="risk-score-big ${levelKey}" id="risk-score-disp">${score}</div>
        <div>
          <div class="risk-result-label" id="risk-level-disp">${level.toUpperCase()}</div>
          <div class="risk-result-desc" id="risk-desc-disp">${riskDesc(levelKey)}</div>
        </div>
      </div>

      <div class="wizard-nav">
        <button class="btn btn-ghost" id="step-prev">← Atrás</button>
        <button class="btn btn-primary" id="step4-next">Siguiente →</button>
      </div>
    </div>`;
}

function riskDesc(k) {
  const m = {
    bajo: 'Riesgo aceptable. Monitorear periódicamente.',
    medio: 'Atención recomendada. Planificar mejoras.',
    alto: 'Requiere acción correctiva en el corto plazo.',
    critico: 'Acción inmediata requerida. Riesgo inaceptable.'
  };
  return m[k] || '';
}

// ── PASO 5: Fotos ─────────────────────────────────────────────
function renderStep5(d) {
  const previewsHtml = State.selectedFiles.map((f, idx) => {
    const url = URL.createObjectURL(f);
    return `
      <div class="photo-preview-item">
        <img src="${url}" alt="Foto ${idx+1}">
        <button type="button" class="remove-photo" data-idx="${idx}">✕</button>
      </div>`;
  }).join('');

  return `
    <div class="card">
      <div class="wizard-screen-title">📸 Evidencia Fotográfica</div>
      <div class="wizard-screen-subtitle">
        Agregá fotos como evidencia. Máximo 10 imágenes, 10 MB c/u.
        Es opcional pero recomendado.
      </div>

      <div class="photo-upload-area" id="photo-drop-zone">
        <div class="upload-icon">📷</div>
        <p><strong>Tocá para agregar fotos</strong></p>
        <p>Desde cámara o galería · JPG, PNG, WEBP</p>
        <input type="file" id="f-photos" accept="image/*" multiple style="display:none;">
      </div>

      <div class="photo-previews" id="photo-previews">${previewsHtml}</div>

      <p style="font-size:.8rem;color:var(--gray-400);margin-top:.5rem;text-align:center;">
        ${State.selectedFiles.length} foto(s) seleccionada(s)
      </p>

      <div class="wizard-nav">
        <button class="btn btn-ghost" id="step-prev">← Atrás</button>
        <button class="btn btn-primary" id="step5-next">Siguiente →</button>
      </div>
    </div>`;
}

// ── PASO 6: Generación IA + Envío ─────────────────────────────
function renderStep6(d, state = 'idle') {
  const score    = d.probability * d.impact;
  const level    = calcRiskLevel(score);
  const levelKey = riskClass(level);

  if (state === 'generating') {
    return `
      <div class="card">
        <div class="ai-generating">
          <div class="ai-icon-wrap">🤖</div>
          <div class="ai-status-text">Generando informe con IA...</div>
          <div class="ai-status-sub">
            Analizando ${Object.values(d.areas).filter(a=>a.affected).length} vulnerabilidades detectadas
          </div>
        </div>
      </div>`;
  }

  const hasDesc  = d.descripcion?.trim().length > 0;
  const hasRec   = d.recomendaciones?.trim().length > 0;

  return `
    <div class="card">
      <div class="wizard-screen-title">🤖 Revisión del Informe</div>
      <div class="wizard-screen-subtitle">
        La IA redactó el informe. Revisá y editá si necesitás, luego envialo.
      </div>

      <!-- Resumen -->
      <div class="risk-result ${levelKey}" style="margin-bottom:1rem;">
        <div class="risk-score-big ${levelKey}">${score}</div>
        <div>
          <div class="risk-result-label">${level.toUpperCase()}</div>
          <div class="risk-result-desc">
            ${escHtml(d.client)} · ${escHtml(d.service_type)}<br>
            Prob ${d.probability}/5 · Impacto ${d.impact}/5
          </div>
        </div>
      </div>

      ${hasDesc ? `
      <div class="ai-result-box" id="desc-box">
        <div class="ai-label">🤖 Descripción de vulnerabilidades</div>
        <div class="ai-text" id="desc-text">${escHtml(d.descripcion)}</div>
        <button class="edit-btn" onclick="toggleEdit('desc')">✏️ Editar</button>
      </div>` : `
      <div class="ai-result-box">
        <div class="ai-label">Descripción de vulnerabilidades</div>
        <textarea class="form-textarea" id="desc-text" rows="5"
          placeholder="Escribí la descripción manualmente...">${escHtml(d.descripcion)}</textarea>
      </div>`}

      ${hasRec ? `
      <div class="ai-result-box" id="rec-box">
        <div class="ai-label">✅ Recomendaciones</div>
        <div class="ai-text" id="rec-text">${escHtml(d.recomendaciones)}</div>
        <button class="edit-btn" onclick="toggleEdit('rec')">✏️ Editar</button>
      </div>` : `
      <div class="ai-result-box">
        <div class="ai-label">Recomendaciones</div>
        <textarea class="form-textarea" id="rec-text" rows="5"
          placeholder="Escribí las recomendaciones manualmente...">${escHtml(d.recomendaciones)}</textarea>
      </div>`}

      ${!hasDesc || !hasRec ? '' : ''}

      <div class="wizard-nav">
        <button class="btn btn-ghost" id="step-prev">← Atrás</button>
        <button class="btn btn-primary" id="btn-submit-final">
          📤 Enviar Informe
        </button>
      </div>

      ${!hasDesc ? `
      <div style="margin-top:.75rem;">
        <button class="btn btn-accent btn-full" id="btn-retry-ai">
          🤖 Generar con IA
        </button>
      </div>` : ''}
    </div>`;
}

// ════════════════════════════════════════════════════════════════
//  BIND EVENTS POR PASO
// ════════════════════════════════════════════════════════════════
function bindStepEvents(step) {
  const d = State.wizard.data;

  // Botón atrás común
  document.getElementById('step-prev')?.addEventListener('click', () => {
    State.wizard.step--;
    renderWizard();
  });

  if (step === 1) {
    document.getElementById('step1-next').addEventListener('click', () => {
      const client  = document.getElementById('w-client').value.trim();
      const address = document.getElementById('w-address').value.trim();
      const service = document.getElementById('w-service').value;

      if (!client || !address || !service) {
        toast('Completá cliente, dirección y tipo de servicio', 'error');
        return;
      }
      d.client       = client;
      d.address      = address;
      d.service_type = service;
      d.report_date  = document.getElementById('w-date').value;
      State.wizard.step = 2;
      renderWizard();
    });
  }

  if (step === 2) {
    // Toggle área
    document.querySelectorAll('.area-card').forEach(card => {
      card.addEventListener('click', () => {
        const key     = card.dataset.key;
        const current = d.areas[key];

        if (!current) {
          // primer toque → sin novedad
          d.areas[key] = { affected: false, severity: 0, findings: '' };
          card.className = 'area-card ok';
          card.querySelector('.area-status').textContent = '✓ Sin novedad';
        } else if (!current.affected) {
          // segundo toque → vulnerable
          d.areas[key].affected = true;
          d.areas[key].severity = 2;
          card.className = 'area-card vuln';
          card.querySelector('.area-status').textContent = '⚠ Con vulnerabilidad';
        } else {
          // tercer toque → reset
          delete d.areas[key];
          card.className = 'area-card';
          card.querySelector('.area-status').textContent = 'Tocá para evaluar';
        }

        // actualizar conteo
        const evaluated = Object.keys(d.areas).length;
        document.querySelector('.wizard-screen-subtitle strong').textContent =
          `${evaluated} / ${AREAS.length}`;
      });
    });

    document.getElementById('step2-next').addEventListener('click', () => {
      const evaluated = Object.keys(d.areas).length;
      if (evaluated === 0) {
        toast('Evaluá al menos un área antes de continuar', 'error');
        return;
      }
      State.wizard.step = 3;
      renderWizard();
    });
  }

  if (step === 3) {
    // Botones de severidad
    document.querySelectorAll('.sev-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const areaKey = btn.dataset.area;
        const sev     = Number(btn.dataset.sev);

        if (!d.areas[areaKey]) d.areas[areaKey] = { affected: true, severity: sev, findings: '' };
        d.areas[areaKey].severity = sev;

        // Actualizar UI
        btn.closest('.severity-buttons').querySelectorAll('.sev-btn').forEach((b, i) => {
          b.className = `sev-btn ${sev === i+1 ? 'active-'+(i+1) : ''}`;
        });
      });
    });

    // Textos de hallazgos
    document.querySelectorAll('.finding-text').forEach(ta => {
      ta.addEventListener('input', () => {
        const key = ta.dataset.area;
        if (d.areas[key]) d.areas[key].findings = ta.value;
      });
    });

    // Fotos por hallazgo
    document.querySelectorAll('.fp-input').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.dataset.area;
        if (!State.areaPhotos[key]) State.areaPhotos[key] = [];
        Array.from(input.files).forEach(f => {
          if (State.areaPhotos[key].length < 4) State.areaPhotos[key].push(f);
          else toast('Máx. 4 fotos por área', 'error');
        });
        input.value = '';
        rerenderFindingPhotos(key, d);
      });
    });

    document.querySelectorAll('.fp-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.area;
        State.areaPhotos[key]?.splice(Number(btn.dataset.idx), 1);
        rerenderFindingPhotos(key, d);
      });
    });

    document.getElementById('step3-next').addEventListener('click', () => {
      d.extra_notes = document.getElementById('w-extra-notes')?.value || '';
      State.wizard.step = 4;
      renderWizard();
    });
  }

  if (step === 4) {
    const updateRisk = () => {
      const p = Number(document.getElementById('w-probability').value);
      const i = Number(document.getElementById('w-impact').value);
      d.probability = p;
      d.impact      = i;
      const score    = p * i;
      const level    = calcRiskLevel(score);
      const levelKey = riskClass(level);

      document.getElementById('prob-val').textContent    = p;
      document.getElementById('impact-val').textContent  = i;
      document.getElementById('prob-display').textContent   = p;
      document.getElementById('impact-display').textContent = i;
      document.getElementById('prob-label-display').textContent   = PROB_LABELS[p];
      document.getElementById('impact-label-display').textContent = IMP_LABELS[i];
      document.getElementById('risk-score-disp').textContent = score;
      document.getElementById('risk-level-disp').textContent = level.toUpperCase();
      document.getElementById('risk-desc-disp').textContent  = riskDesc(levelKey);

      const box = document.getElementById('risk-result-box');
      box.className = `risk-result ${levelKey} mt-3`;
      document.getElementById('risk-score-disp').className = `risk-score-big ${levelKey}`;
    };

    document.getElementById('w-probability').addEventListener('input', updateRisk);
    document.getElementById('w-impact').addEventListener('input', updateRisk);

    document.getElementById('step4-next').addEventListener('click', () => {
      State.wizard.step = 5;
      renderWizard();
    });
  }

  if (step === 5) {
    const dropZone = document.getElementById('photo-drop-zone');
    const fileInput = document.getElementById('f-photos');

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      Array.from(fileInput.files).forEach(addPhoto);
      fileInput.value = '';
      renderPhotoPreviewsInStep5();
    });

    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')).forEach(addPhoto);
      renderPhotoPreviewsInStep5();
    });

    document.querySelectorAll('.remove-photo[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        State.selectedFiles.splice(Number(btn.dataset.idx), 1);
        renderPhotoPreviewsInStep5();
      });
    });

    document.getElementById('step5-next').addEventListener('click', () => {
      State.wizard.step = 6;
      triggerAIGeneration();
    });
  }

  if (step === 6) {
    document.getElementById('btn-submit-final')?.addEventListener('click', submitFinalReport);
    document.getElementById('btn-retry-ai')?.addEventListener('click', triggerAIGeneration);
  }
}

function addPhoto(file) {
  if (State.selectedFiles.length >= 10) { toast('Máx. 10 fotos', 'error'); return; }
  if (file.size > 10 * 1024 * 1024)    { toast(`${file.name}: muy grande (máx 10MB)`, 'error'); return; }
  State.selectedFiles.push(file);
}

function renderPhotoPreviewsInStep5() {
  const container = document.getElementById('photo-previews');
  const counter   = document.querySelector('#wizard-screen p');
  if (!container) return;

  container.innerHTML = State.selectedFiles.map((f, idx) => {
    const url = URL.createObjectURL(f);
    return `
      <div class="photo-preview-item">
        <img src="${url}" alt="Foto ${idx+1}">
        <button type="button" class="remove-photo" data-idx="${idx}">✕</button>
      </div>`;
  }).join('');

  if (counter) counter.textContent = `${State.selectedFiles.length} foto(s) seleccionada(s)`;

  // Re-bind remove buttons
  container.querySelectorAll('.remove-photo[data-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      State.selectedFiles.splice(Number(btn.dataset.idx), 1);
      renderPhotoPreviewsInStep5();
    });
  });
}

function rerenderFindingPhotos(areaKey, d) {
  const list = document.getElementById(`fp-list-${areaKey}`);
  const btn  = document.querySelector(`label[for="fp-input-${areaKey}"]`);
  if (!list) return;
  const photos = State.areaPhotos[areaKey] || [];
  list.innerHTML = photos.map((f, idx) => `
    <div class="fp-item">
      <img src="${URL.createObjectURL(f)}" alt="foto">
      <button type="button" class="fp-remove" data-area="${areaKey}" data-idx="${idx}">✕</button>
    </div>`).join('');
  if (btn) btn.childNodes[0].textContent = `📷 ${photos.length ? `${photos.length} foto(s)` : 'Agregar foto'}`;
  list.querySelectorAll('.fp-remove').forEach(b => {
    b.addEventListener('click', () => {
      State.areaPhotos[areaKey]?.splice(Number(b.dataset.idx), 1);
      rerenderFindingPhotos(areaKey, d);
    });
  });
}

// Genera informe automático desde los datos (sin IA)
function generateReportFromData(d) {
  const vulnAreas = AREAS.filter(a => d.areas[a.key]?.affected);
  const okAreas   = AREAS.filter(a => d.areas[a.key] && !d.areas[a.key].affected);
  const score     = d.probability * d.impact;
  const level     = calcRiskLevel(score);
  const sevLabel  = ['', 'leve', 'moderada', 'significativa', 'grave'];
  const date      = d.report_date ? d.report_date.slice(0, 10) : new Date().toISOString().slice(0, 10);

  let desc = `El presente informe corresponde a la inspección de seguridad realizada en ${d.client}, `;
  desc += `con domicilio en ${d.address}, en el marco del servicio de ${d.service_type}. `;
  desc += `La evaluación fue realizada el ${date} por el supervisor ${State.user.full_name}.\n\n`;

  if (vulnAreas.length === 0) {
    desc += `Durante la inspección no se identificaron vulnerabilidades en ninguna de las áreas evaluadas. `;
    if (okAreas.length) desc += `Las áreas revisadas (${okAreas.map(a=>a.label).join(', ')}) presentaron condiciones adecuadas. `;
    desc += `La puntuación de riesgo obtenida es ${score}/25, nivel ${level}, reflejando un estado de seguridad satisfactorio al momento de la visita.`;
  } else {
    desc += `Se identificaron vulnerabilidades en ${vulnAreas.length} área(s) de las ${Object.keys(d.areas).length} evaluadas:\n`;
    vulnAreas.forEach(a => {
      const info = d.areas[a.key];
      const sev  = sevLabel[info.severity] || 'moderada';
      desc += `• ${a.label} (gravedad ${sev}): ${info.findings?.trim() || 'se detectaron condiciones de riesgo que requieren atención'}.\n`;
    });
    desc += `\nLa evaluación arroja una puntuación de riesgo de ${score}/25, calificada como nivel ${level.toUpperCase()}.`;
    if (d.extra_notes?.trim()) desc += `\n\nObservaciones adicionales: ${d.extra_notes.trim()}`;
  }

  let recs;
  if (vulnAreas.length === 0) {
    recs = `Mantener los protocolos de seguridad actuales. Programar inspecciones periódicas para verificar la continuidad de las condiciones observadas. Registrar este informe en el historial para seguimiento preventivo.`;
  } else {
    const lines = vulnAreas.map(a => {
      const info     = d.areas[a.key];
      const sev      = info.severity || 2;
      const priority = sev >= 3 ? 'PRIORIDAD INMEDIATA' : 'PRIORIDAD CORTO PLAZO';
      const action   = info.findings?.trim()
        ? `Subsanar la siguiente condición: "${info.findings.trim()}".`
        : `Revisar y corregir la condición insegura detectada.`;
      return `${priority} — ${a.label}: ${action} Verificar corrección en próxima visita.`;
    });
    lines.push(`Informar al área responsable del cliente sobre las vulnerabilidades detectadas y solicitar conformidad escrita de las acciones correctivas implementadas.`);
    recs = lines.join('\n');
  }

  return { descripcion: desc, recomendaciones: recs };
}

// ════════════════════════════════════════════════════════════════
//  GENERACIÓN IA
// ════════════════════════════════════════════════════════════════
async function triggerAIGeneration() {
  State.wizard.step = 6;
  // Mostrar pantalla de generando
  document.getElementById('report-form-container').innerHTML = `
    <div class="wizard-progress">
      <div class="wizard-steps">
        ${STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const cls = n < 6 ? 'done' : 'active';
          return `<div class="wizard-step-dot ${cls}">
            <div class="dot">${n < 6 ? '✓' : n}</div>
            <div class="dot-label">${label}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="wizard-screen" id="wizard-screen">
      ${renderStep6(State.wizard.data, 'generating')}
    </div>`;

  const d = State.wizard.data;

  try {
    const result = await api('POST', '/ai/generate-report', {
      client:          d.client,
      address:         d.address,
      service_type:    d.service_type,
      supervisor_name: State.user.full_name,
      areas:           d.areas,
      probability:     d.probability,
      impact:          d.impact,
      risk_score:      d.probability * d.impact,
      risk_level:      calcRiskLevel(d.probability * d.impact),
      extra_notes:     d.extra_notes,
    });

    d.descripcion     = result.descripcion     || '';
    d.recomendaciones = result.recomendaciones || '';

    if (result.fallback) {
      // IA no configurada → usar generador automático
      const auto = generateReportFromData(d);
      d.descripcion     = auto.descripcion;
      d.recomendaciones = auto.recomendaciones;
      toast('Informe generado automáticamente ✓', 'success');
    } else {
      toast('Informe generado por IA ✓', 'success');
    }
  } catch (err) {
    // Error de red → usar generador automático como fallback
    const auto = generateReportFromData(d);
    d.descripcion     = auto.descripcion;
    d.recomendaciones = auto.recomendaciones;
    toast('Informe generado automáticamente ✓', 'success');
  }

  renderWizard();
}

// Toggle edición inline en paso 6
window.toggleEdit = function(field) {
  const box     = document.getElementById(field === 'desc' ? 'desc-box' : 'rec-box');
  const textDiv = document.getElementById(field === 'desc' ? 'desc-text' : 'rec-text');
  const isDiv   = textDiv.tagName === 'DIV';

  if (isDiv) {
    // Convertir a textarea
    const currentText = textDiv.textContent;
    const ta = document.createElement('textarea');
    ta.className = 'ai-editable';
    ta.id        = textDiv.id;
    ta.value     = currentText;
    ta.setAttribute('rows', '6');
    textDiv.replaceWith(ta);
    box.querySelector('.edit-btn').textContent = '💾 Guardar';
    ta.focus();
  } else {
    // Guardar y volver a div
    const newText = textDiv.value;
    if (field === 'desc') State.wizard.data.descripcion     = newText;
    else                  State.wizard.data.recomendaciones = newText;

    const div = document.createElement('div');
    div.className = 'ai-text';
    div.id        = textDiv.id;
    div.textContent = newText;
    textDiv.replaceWith(div);
    box.querySelector('.edit-btn').textContent = '✏️ Editar';
  }
};

// ════════════════════════════════════════════════════════════════
//  ENVÍO FINAL DEL INFORME
// ════════════════════════════════════════════════════════════════
async function submitFinalReport() {
  const d = State.wizard.data;

  // Capturar texto si fue editado en textarea
  const descEl = document.getElementById('desc-text');
  const recEl  = document.getElementById('rec-text');
  if (descEl?.tagName === 'TEXTAREA') d.descripcion     = descEl.value;
  if (recEl?.tagName === 'TEXTAREA')  d.recomendaciones = recEl.value;
  if (descEl?.tagName === 'DIV')      d.descripcion     = descEl.textContent;
  if (recEl?.tagName === 'DIV')       d.recomendaciones = recEl.textContent;

  // Armar checklist para la DB
  const checklist = {};
  Object.entries(d.areas).forEach(([k, v]) => {
    if (v.affected) checklist[k] = true;
  });

  const formData = new FormData();
  formData.append('client',                    d.client);
  formData.append('address',                   d.address);
  formData.append('service_type',              d.service_type);
  formData.append('report_date',               d.report_date);
  formData.append('vulnerability_description', d.descripcion || '');
  formData.append('checklist',                 JSON.stringify(checklist));
  formData.append('probability',               d.probability);
  formData.append('impact',                    d.impact);
  formData.append('recommendations',           d.recomendaciones || '');
  // Fotos globales (paso 5)
  State.selectedFiles.forEach(f => formData.append('images', f));
  // Fotos por hallazgo (paso 3) — prefijo "fp_AREAKEY"
  Object.entries(State.areaPhotos).forEach(([key, files]) => {
    files.forEach(f => formData.append(`fp_${key}`, f));
  });

  const btn = document.getElementById('btn-submit-final');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Enviando...';

  try {
    const method = State.editingReportId ? 'PUT' : 'POST';
    const path   = State.editingReportId ? `/reports/${State.editingReportId}` : '/reports';
    await api(method, path, formData, true);

    toast(State.editingReportId ? 'Informe actualizado ✓' : '¡Informe enviado correctamente! ✓', 'success');
    resetWizard();
    await loadReports();
    goToTab('reports');
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = '📤 Enviar Informe';
  }
}

// ════════════════════════════════════════════════════════════════
//  LISTA DE INFORMES
// ════════════════════════════════════════════════════════════════
async function loadReports() {
  const client     = document.getElementById('filter-client')?.value || '';
  const risk       = document.getElementById('filter-risk')?.value   || '';
  const dateFrom   = document.getElementById('filter-date-from')?.value || '';
  const dateTo     = document.getElementById('filter-date-to')?.value   || '';
  const supervisor = document.getElementById('filter-supervisor')?.value || '';

  const params = new URLSearchParams();
  if (client)     params.set('client',        client);
  if (risk)       params.set('risk_level',    risk);
  if (dateFrom)   params.set('date_from',     dateFrom);
  if (dateTo)     params.set('date_to',       dateTo);
  if (supervisor) params.set('supervisor_id', supervisor);

  const listEl = document.getElementById('reports-list');
  listEl.innerHTML = '<div class="empty-state"><div class="icon">⏳</div><p>Cargando informes...</p></div>';

  try {
    const reports = await api('GET', `/reports?${params}`);
    State.reports = reports;
    renderReportList(reports);
    updateStats(reports);
  } catch {
    listEl.innerHTML =
      '<div class="empty-state"><div class="icon">⚠️</div><p>Error al cargar informes</p></div>';
  }
}

document.getElementById('btn-filter')?.addEventListener('click', loadReports);

document.getElementById('btn-clear-filters')?.addEventListener('click', () => {
  document.getElementById('filter-client').value    = '';
  document.getElementById('filter-risk').value      = '';
  document.getElementById('filter-date-from').value = '';
  document.getElementById('filter-date-to').value   = '';
  const supSel = document.getElementById('filter-supervisor');
  if (supSel) supSel.value = '';
  loadReports();
});

async function populateSupervisorFilter() {
  try {
    const users = await api('GET', '/users');
    const sel = document.getElementById('filter-supervisor');
    if (!sel) return;
    users.filter(u => u.role === 'supervisor').forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = `👮 ${u.full_name}`;
      sel.appendChild(opt);
    });
  } catch {}
}

document.getElementById('btn-export-csv')?.addEventListener('click', () => {
  fetch('/api/reports/export/csv', { headers: { Authorization: `Bearer ${State.token}` } })
    .then(r => r.blob()).then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'informes.csv'; a.click();
    });
});

function updateStats(reports) {
  document.getElementById('stat-total').textContent   = reports.length;
  document.getElementById('stat-critico').textContent = reports.filter(r => r.risk_level === 'Crítico').length;
  document.getElementById('stat-alto').textContent    = reports.filter(r => r.risk_level === 'Alto').length;
  document.getElementById('stat-medio').textContent   = reports.filter(r => r.risk_level === 'Medio').length;
}

function renderReportList(reports) {
  const container = document.getElementById('reports-list');
  if (!reports.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="icon">📋</div>
      <p>No se encontraron informes</p>
    </div>`;
    return;
  }

  container.innerHTML = reports.map(r => `
    <div class="report-card ${riskClass(r.risk_level)}" onclick="openReportDetail(${r.id})">
      <div class="report-card-header">
        <div>
          <h3>${escHtml(r.client)}</h3>
          <div style="font-size:.8rem;color:var(--gray-600);">${escHtml(r.address)}</div>
        </div>
        ${badgeHtml(r.risk_level)}
      </div>
      <div class="meta">
        <span>${escHtml(r.service_type)}</span>
        <span>${escHtml(r.supervisor_name)}</span>
        <span>${formatDate(r.report_date)}</span>
        ${r.images?.length ? `<span>📷 ${r.images.length}</span>` : ''}
      </div>
    </div>
  `).join('');
}

// ════════════════════════════════════════════════════════════════
//  DETALLE INFORME
// ════════════════════════════════════════════════════════════════
const AREA_LABELS = {
  iluminacion: 'Iluminación', perimetro: 'Perímetro', accesos: 'Accesos',
  camaras: 'CCTV', cerraduras: 'Cerraduras', guardias: 'Guardias',
  comunicaciones: 'Comunicaciones', materiales: 'Mat. peligrosos',
  emergencias: 'Emergencias', vehiculos: 'Vehicular',
};

window.openReportDetail = async function(id) {
  try {
    const r        = await api('GET', `/reports/${id}`);
    const levelKey = riskClass(r.risk_level);

    const checkedItems = Object.entries(r.checklist || {})
      .filter(([,v]) => v)
      .map(([k]) => AREA_LABELS[k] || k);

    document.getElementById('modal-title').textContent = `Informe N° ${String(r.id).padStart(5,'0')}`;

    document.getElementById('modal-body').innerHTML = `
      <div class="risk-result ${levelKey}" style="margin-bottom:1rem;">
        <div class="risk-score-big ${levelKey}">${r.risk_score}</div>
        <div>
          <div class="risk-result-label">${r.risk_level.toUpperCase()}</div>
          <div class="risk-result-desc">Prob: ${r.probability}/5 · Impacto: ${r.impact}/5</div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Datos del servicio</h3>
        <table class="detail-table">
          <tr><td>Cliente</td><td>${escHtml(r.client)}</td></tr>
          <tr><td>Dirección</td><td>${escHtml(r.address)}</td></tr>
          <tr><td>Tipo</td><td>${escHtml(r.service_type)}</td></tr>
          <tr><td>Fecha</td><td>${formatDate(r.report_date)}</td></tr>
          <tr><td>Supervisor</td><td>${escHtml(r.supervisor_name)}</td></tr>
        </table>
      </div>

      ${r.vulnerability_description ? `
      <div class="detail-section">
        <h3>Vulnerabilidades detectadas</h3>
        <p style="font-size:.9rem;line-height:1.65;white-space:pre-wrap;">${escHtml(r.vulnerability_description)}</p>
      </div>` : ''}

      ${checkedItems.length ? `
      <div class="detail-section">
        <h3>Áreas afectadas</h3>
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;">
          ${checkedItems.map(l => `<span class="badge badge-medio">${l}</span>`).join('')}
        </div>
      </div>` : ''}

      ${r.recommendations ? `
      <div class="detail-section">
        <h3>Recomendaciones</h3>
        <p style="font-size:.9rem;line-height:1.65;white-space:pre-wrap;">${escHtml(r.recommendations)}</p>
      </div>` : ''}

      ${r.images?.length ? `
      <div class="detail-section">
        <h3>Evidencia fotográfica (${r.images.length})</h3>
        <div class="detail-photos">
          ${r.images.map(img =>
            `<img src="/uploads/${img.filename}" onclick="openLightbox('/uploads/${img.filename}')">`
          ).join('')}
        </div>
      </div>` : ''}

      <div style="font-size:.75rem;color:var(--gray-400);margin-top:.5rem;">
        Creado: ${formatDate(r.created_at)}
      </div>`;

    document.getElementById('modal-footer').innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="downloadPDF(${r.id})">⬇ PDF</button>
      ${State.user.role === 'admin' || r.supervisor_id === State.user.id
        ? `<button class="btn btn-accent btn-sm" onclick="editReport(${r.id})">✏️ Editar</button>` : ''}
      ${State.user.role === 'admin'
        ? `<button class="btn btn-danger btn-sm" onclick="deleteReport(${r.id})">🗑 Eliminar</button>` : ''}`;

    document.getElementById('modal-report').classList.remove('hidden');
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.downloadPDF = async function(id) {
  // El servidor devuelve HTML optimizado para imprimir/guardar como PDF
  try {
    const res = await fetch(`/api/reports/${id}/pdf`, {
      headers: { Authorization: `Bearer ${State.token}` }
    });
    if (!res.ok) throw new Error('Error generando informe');
    const html = await res.text();
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    toast('Informe abierto — usá Imprimir para guardar PDF ✓', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.editReport = async function(id) {
  closeModal('modal-report');
  try {
    const r = await api('GET', `/reports/${id}`);
    resetWizard();
    State.editingReportId = id;

    const d = State.wizard.data;
    d.client       = r.client;
    d.address      = r.address;
    d.service_type = r.service_type;
    d.report_date  = r.report_date?.slice(0,16) || d.report_date;
    d.probability  = r.probability;
    d.impact       = r.impact;
    d.descripcion     = r.vulnerability_description;
    d.recomendaciones = r.recommendations;

    // Reconstruir areas desde checklist
    Object.entries(r.checklist || {}).forEach(([k, v]) => {
      if (v) d.areas[k] = { affected: true, severity: 2, findings: '' };
    });

    goToTab('new-report');
    renderWizard();
    toast('Editando informe. Completá los pasos y envialo.', 'default');
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.deleteReport = async function(id) {
  if (!confirm('¿Eliminar este informe? Esta acción no se puede deshacer.')) return;
  try {
    await api('DELETE', `/reports/${id}`);
    closeModal('modal-report');
    toast('Informe eliminado', 'success');
    await loadReports();
  } catch (err) {
    toast(err.message, 'error');
  }
};

// Cerrar modal
document.getElementById('modal-close').addEventListener('click', () => closeModal('modal-report'));
document.getElementById('modal-report').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal('modal-report');
});
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// Lightbox
window.openLightbox = function(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
};
document.getElementById('lightbox').addEventListener('click', () => {
  document.getElementById('lightbox').classList.add('hidden');
});

// ════════════════════════════════════════════════════════════════
//  PANEL ADMINISTRADOR
// ════════════════════════════════════════════════════════════════
async function buildAdminPanel() {
  const container = document.getElementById('tab-admin');
  container.innerHTML = `

    <!-- Acceso rápido supervisores -->
    <div class="card" id="card-access">
      <div class="card-header">
        <h2 style="font-size:1.1rem;font-weight:700;">📲 Acceso para Supervisores</h2>
        <button class="btn btn-primary btn-sm" id="btn-open-qr">🔗 Ver QR</button>
      </div>
      <div id="access-info" style="font-size:.85rem;color:var(--gray-600);padding:.25rem 0;">
        Cargando dirección de red...
      </div>
    </div>

    <!-- Estadísticas globales -->
    <div class="card">
      <div class="card-header">
        <h2 style="font-size:1.1rem;font-weight:700;">📊 Estadísticas Globales</h2>
      </div>
      <div id="admin-stats"></div>
    </div>

    <!-- Gestión de usuarios -->
    <div class="card">
      <div class="card-header">
        <h2 style="font-size:1.1rem;font-weight:700;">👤 Gestión de Usuarios</h2>
        <button class="btn btn-primary btn-sm" id="btn-new-user">+ Nuevo</button>
      </div>
      <div id="users-list"><p style="color:var(--gray-400);font-size:.875rem;">Cargando...</p></div>
    </div>`;

  document.getElementById('btn-new-user').addEventListener('click', () => openUserModal(null));
  document.getElementById('btn-open-qr').addEventListener('click', () => {
    window.open('/qr', '_blank', 'width=480,height=640');
  });
  await loadNetworkInfo();
  await refreshUsers();
  await loadAdminStats();
}

async function loadNetworkInfo() {
  try {
    const info = await api('GET', '/network-info');
    const el = document.getElementById('access-info');
    if (!el) return;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;">
        <div>
          <div style="font-size:.75rem;color:var(--gray-400);text-transform:uppercase;font-weight:700;letter-spacing:.4px;">URL de acceso en red local</div>
          <div style="font-size:1rem;font-weight:800;color:var(--primary);font-family:monospace;margin-top:3px;">${info.url}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${info.url}').then(()=>toast('URL copiada','success'))">📋 Copiar</button>
      </div>
      <div style="font-size:.72rem;color:var(--gray-400);margin-top:.5rem;">
        Los supervisores deben estar conectados a la misma red WiFi para acceder.
      </div>`;
  } catch {
    const el = document.getElementById('access-info');
    if (el) el.textContent = 'No se pudo obtener la dirección de red.';
  }
}

async function refreshUsers() {
  try {
    const users = await api('GET', '/users');
    const el = document.getElementById('users-list');
    if (!el) return;
    el.innerHTML = users.map(u => `
      <div class="user-row">
        <div>
          <div class="user-name">${escHtml(u.full_name)}</div>
          <div class="user-meta">
            @${u.username} · ${u.role === 'admin' ? '⚙️ Admin' : '👮 Supervisor'}
            · ${u.active ? '🟢 Activo' : '🔴 Inactivo'}
          </div>
        </div>
        <div class="user-actions">
          <button class="btn btn-ghost btn-sm" onclick="openUserModal(${u.id})">✏️</button>
          <button class="btn btn-danger btn-sm" onclick="confirmDeleteUser(${u.id},'${escHtml(u.full_name)}')">🗑</button>
        </div>
      </div>`).join('');
  } catch (err) { toast(err.message, 'error'); }
}

async function loadAdminStats() {
  try {
    const [reports, users] = await Promise.all([api('GET', '/reports'), api('GET', '/users')]);
    const el = document.getElementById('admin-stats');
    if (!el) return;

    const byLevel = { Bajo: 0, Medio: 0, Alto: 0, Crítico: 0 };
    reports.forEach(r => { if (byLevel[r.risk_level] !== undefined) byLevel[r.risk_level]++; });

    // Por supervisor
    const supMap = {};
    users.filter(u => u.role === 'supervisor').forEach(u => { supMap[u.id] = { name: u.full_name, count: 0 }; });
    reports.forEach(r => { if (supMap[r.supervisor_id]) supMap[r.supervisor_id].count++; });
    const supRows = Object.values(supMap)
      .sort((a,b) => b.count - a.count)
      .map(s => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--gray-100);">
          <span style="font-size:.875rem;font-weight:600;">👮 ${escHtml(s.name)}</span>
          <span class="badge badge-medio">${s.count} informe${s.count !== 1 ? 's' : ''}</span>
        </div>`).join('') || '<p style="color:var(--gray-400);font-size:.85rem;">Sin supervisores aún</p>';

    el.innerHTML = `
      <div class="stats-grid" style="margin-bottom:1.25rem;">
        <div class="stat-card"><div class="num">${reports.length}</div><div class="label">Total</div></div>
        <div class="stat-card critico"><div class="num">${byLevel['Crítico']}</div><div class="label">Críticos</div></div>
        <div class="stat-card alto"><div class="num">${byLevel['Alto']}</div><div class="label">Altos</div></div>
        <div class="stat-card medio"><div class="num">${byLevel['Medio']}</div><div class="label">Medios</div></div>
      </div>
      <div style="margin-top:.25rem;">
        <div style="font-size:.75rem;font-weight:700;color:var(--gray-600);text-transform:uppercase;letter-spacing:.4px;margin-bottom:.5rem;">Informes por Supervisor</div>
        ${supRows}
      </div>`;
  } catch {}
}

let _editUserId = null;

window.openUserModal = async function(userId) {
  _editUserId = userId;
  document.getElementById('user-modal-title').textContent = userId ? 'Editar Usuario' : 'Nuevo Usuario';
  document.getElementById('user-form').reset();

  if (userId) {
    try {
      const users = await api('GET', '/users');
      const u = users.find(x => x.id === userId);
      if (u) {
        document.getElementById('u-fullname').value = u.full_name;
        document.getElementById('u-username').value  = u.username;
        document.getElementById('u-role').value      = u.role;
        document.getElementById('u-active').value    = u.active;
        document.getElementById('u-username').disabled = true;
      }
    } catch {}
  } else {
    document.getElementById('u-username').disabled = false;
  }
  document.getElementById('modal-user').classList.remove('hidden');
};

document.getElementById('user-modal-close').addEventListener('click',  () => closeModal('modal-user'));
document.getElementById('user-modal-cancel').addEventListener('click', () => closeModal('modal-user'));
document.getElementById('modal-user').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal('modal-user');
});

document.getElementById('user-modal-save').addEventListener('click', async () => {
  const fullName = document.getElementById('u-fullname').value.trim();
  const username = document.getElementById('u-username').value.trim();
  const role     = document.getElementById('u-role').value;
  const active   = Number(document.getElementById('u-active').value);
  const password = document.getElementById('u-password').value;

  if (!fullName) { toast('El nombre es requerido', 'error'); return; }
  if (!_editUserId && !username) { toast('El usuario es requerido', 'error'); return; }
  if (!_editUserId && !password) { toast('La contraseña es requerida', 'error'); return; }

  const body = { full_name: fullName, role, active };
  if (!_editUserId) { body.username = username; body.password = password; }
  else if (password) body.password = password;

  try {
    if (_editUserId) await api('PUT',  `/users/${_editUserId}`, body);
    else             await api('POST', '/users', body);
    toast(_editUserId ? 'Usuario actualizado ✓' : 'Usuario creado ✓', 'success');
    closeModal('modal-user');
    await refreshUsers();
  } catch (err) { toast(err.message, 'error'); }
});

window.confirmDeleteUser = async function(id, name) {
  if (!confirm(`¿Eliminar al usuario "${name}"?`)) return;
  try {
    await api('DELETE', `/users/${id}`);
    toast('Usuario eliminado', 'success');
    await refreshUsers();
  } catch (err) { toast(err.message, 'error'); }
};
