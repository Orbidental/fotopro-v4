'use strict';
// ═══════════════════════════════════════════════════════════
//  FotoPro Productos v3.0 — Interfaz iOS, funciones nuevas
//  + Temporizador, Histograma, Macro, Desbloqueo siempre visible
// ═══════════════════════════════════════════════════════════

const state = {
  stream: null, track: null, imageCapture: null,
  currentPanel: null, locked: false, flashOn: false, frontCam: false,
  macroMode: false,
  ev: 0, wb: 5500, iso: 0, zoom: 1.0,
  zoomMin: 1.0, zoomMax: 5.0,
  format: 'image/jpeg', width: 1200, height: 1200, quality: 0.95,
  autoNumber: true, whiteBg: false, sharpen: false, guidedShot: false,
  showGrid: false, showHistogram: false,
  timerMode: 0,        // 0=off, 3=3s, 10=10s
  timerRunning: false,
  photoCount: 0, savedFiles: {}, lastThumbUrl: null,
  _pinchDist: null, _pinchZoomStart: null,
  _focusLockTimer: null,
};

const ISO_VALS   = ['Auto', 50, 100, 200, 400, 800, 1600];
const WB_PRESETS = {
  auto:        { label: 'Auto',    k: 0    },
  daylight:    { label: 'Sol',     k: 5500 },
  cloudy:      { label: 'Nublado', k: 6500 },
  fluorescent: { label: 'Fluor.',  k: 4000 },
  tungsten:    { label: 'Tungst.', k: 2800 },
};
const EV_PRESETS = {
  auto:  { ev: 0    },
  light: { ev: 1.0  },
  dark:  { ev: -1.0 },
  white: { ev: 1.3  },
};

const $ = id => document.getElementById(id);
const screens = { cam: $('cam-screen'), settings: $('settings-screen'), preview: $('preview-screen') };
const video  = $('video');
const canvas = $('canvas');
const ctx    = canvas.getContext('2d', { willReadFrequently: true });
const histCanvas = $('histogram-canvas');
const histCtx    = histCanvas ? histCanvas.getContext('2d') : null;

// ── INIT ──────────────────────────────────────────────────
async function init() {
  loadSettings();
  await startCamera();
  bindEvents();
  applySettingsUI();
  updateQuickLabels();
  startHistogramLoop();
}

// ── CÁMARA ────────────────────────────────────────────────
async function startCamera() {
  try {
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    const constraints = {
      video: {
        facingMode: state.frontCam ? 'user' : { ideal: 'environment' },
        width: { ideal: 4096 }, height: { ideal: 3072 },
      },
      audio: false,
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = state.stream;
    await video.play();
    state.track = state.stream.getVideoTracks()[0];
    if ('ImageCapture' in window) state.imageCapture = new ImageCapture(state.track);

    if (state.track.getCapabilities) {
      const caps = state.track.getCapabilities();
      if (caps.zoom) {
        state.zoomMin = caps.zoom.min || 1.0;
        state.zoomMax = caps.zoom.max || 5.0;
        $('sl-zoom').min  = state.zoomMin;
        $('sl-zoom').max  = state.zoomMax;
      }
    }
    state.zoom = state.zoomMin;
    $('sl-zoom').value = state.zoom;
    updateQuickLabels();
    await applyManualControls();
  } catch (err) {
    showToast('Error cámara: ' + err.message, 'warn');
  }
}

// ── CONTROLES MANUALES ────────────────────────────────────
async function applyManualControls() {
  if (!state.track?.getCapabilities) return;
  const caps = state.track.getCapabilities();
  const adv  = {};

  if (caps.exposureCompensation) {
    adv.exposureCompensation = Math.max(
      caps.exposureCompensation.min ?? -3,
      Math.min(caps.exposureCompensation.max ?? 3, state.ev)
    );
    adv.exposureMode = 'continuous';
  }
  if (state.wb === 0) {
    if (caps.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous';
  } else if (caps.colorTemperature) {
    adv.colorTemperature = Math.max(caps.colorTemperature.min ?? 2500,
      Math.min(caps.colorTemperature.max ?? 7500, state.wb));
    if (caps.whiteBalanceMode?.includes('manual')) adv.whiteBalanceMode = 'manual';
  }
  if (caps.iso && state.iso > 0) {
    const iv = ISO_VALS[state.iso];
    if (typeof iv === 'number')
      adv.iso = Math.max(caps.iso.min ?? 50, Math.min(caps.iso.max ?? 3200, iv));
  }
  if (caps.zoom) {
    adv.zoom = Math.max(caps.zoom.min ?? 1, Math.min(caps.zoom.max ?? 5, state.zoom));
  }

  try {
    if (Object.keys(adv).length) await state.track.applyConstraints({ advanced: [adv] });
  } catch(e) {}

  if (!caps.zoom && state.zoom > 1) {
    video.style.transform = `scale(${state.zoom})`;
  } else {
    video.style.transform = '';
  }
  updateZoomIndicator();
}

function updateZoomIndicator() {
  const ind = $('zoom-indicator');
  if (!ind) return;
  ind.textContent = state.zoom.toFixed(1) + '×';
  ind.classList.toggle('visible', state.zoom > state.zoomMin + 0.05);
}

// ── TAP TO FOCUS ──────────────────────────────────────────
async function handleTapFocus(e) {
  if (state.locked) return;
  const tag = e.target.tagName;
  if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'DIV' && e.target.id !== 'viewfinder') return;

  const rect = $('viewfinder').getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top)  / rect.height;

  const ring = $('focus-ring');
  ring.style.left = (x * 100) + '%';
  ring.style.top  = (y * 100) + '%';
  ring.classList.remove('visible','locked','focusing');
  void ring.offsetWidth;
  ring.classList.add('visible','focusing');

  clearTimeout(state._focusLockTimer);

  if (state.track?.getCapabilities) {
    const caps = state.track.getCapabilities();
    const adv  = {};
    if (caps.focusMode?.includes('single-shot')) adv.focusMode = 'single-shot';
    else if (caps.focusMode?.includes('manual')) adv.focusMode = 'manual';
    if (caps.pointsOfInterest) adv.pointsOfInterest = [{ x, y }];
    try { if (Object.keys(adv).length) await state.track.applyConstraints({ advanced: [adv] }); } catch(e) {}
  }

  setTimeout(() => {
    ring.classList.remove('focusing');
    ring.classList.add('locked');
    state._focusLockTimer = setTimeout(async () => {
      ring.classList.remove('visible','locked');
      if (state.track?.getCapabilities) {
        const caps = state.track.getCapabilities();
        if (caps.focusMode?.includes('continuous')) {
          try { await state.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch(e) {}
        }
      }
    }, 3000);
  }, 500);
}

// ── PINCH TO ZOOM ─────────────────────────────────────────
function getTouchDist(t1, t2) {
  return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
}
function handlePinchStart(e) {
  if (e.touches.length === 2) {
    state._pinchDist = getTouchDist(e.touches[0], e.touches[1]);
    state._pinchZoomStart = state.zoom;
    e.preventDefault();
  }
}
function handlePinchMove(e) {
  if (e.touches.length === 2 && state._pinchDist) {
    e.preventDefault();
    const scale = getTouchDist(e.touches[0], e.touches[1]) / state._pinchDist;
    state.zoom  = Math.round(Math.max(state.zoomMin, Math.min(state.zoomMax, state._pinchZoomStart * scale)) * 10) / 10;
    $('sl-zoom').value = state.zoom;
    updateQuickLabels();
    applyManualControls();
  }
}
function handlePinchEnd() { state._pinchDist = null; state._pinchZoomStart = null; }

// ── TEMPORIZADOR ──────────────────────────────────────────
function cycleTimer() {
  const modes = [0, 3, 10];
  const idx   = modes.indexOf(state.timerMode);
  state.timerMode = modes[(idx + 1) % modes.length];
  const btn = $('btn-timer');
  const lbl = $('timer-label');
  if (state.timerMode === 0) {
    btn.classList.remove('active-red');
    btn.textContent = '⏱';
    lbl.textContent = '';
    lbl.classList.remove('visible');
  } else {
    btn.classList.add('active-red');
    btn.textContent = '⏱';
    lbl.textContent = state.timerMode + 's';
    lbl.classList.add('visible');
    $('btn-capture').classList.add('timer-armed');
  }
  if (state.timerMode === 0) $('btn-capture').classList.remove('timer-armed');
  showToast(state.timerMode === 0 ? 'Temporizador desactivado' : `Temporizador ${state.timerMode}s`, 'ok');
}

function runTimerThenShoot() {
  if (state.timerRunning) return;
  const secs = state.timerMode;
  if (secs === 0) { takePhoto(); return; }

  state.timerRunning = true;
  const display = $('timer-display');
  display.classList.add('visible');
  let remaining = secs;
  display.textContent = remaining;

  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(interval);
      display.classList.remove('visible');
      state.timerRunning = false;
      takePhoto();
    } else {
      display.textContent = remaining;
    }
  }, 1000);
}

// ── MACRO ─────────────────────────────────────────────────
async function toggleMacro() {
  state.macroMode = !state.macroMode;
  const btn   = $('qc-macro');
  const badge = $('macro-badge');

  if (state.macroMode) {
    btn.classList.add('active-blue');
    badge.classList.add('visible');
    // Intentar lente macro si existe, o forzar enfoque cercano
    if (state.track?.getCapabilities) {
      const caps = state.track.getCapabilities();
      try {
        if (caps.focusMode?.includes('manual') && caps.focusDistance) {
          await state.track.applyConstraints({
            advanced: [{ focusMode: 'manual', focusDistance: caps.focusDistance.min }]
          });
        }
      } catch(e) {}
    }
    showToast('🔬 Macro activado — acerca el producto', 'ok');
  } else {
    btn.classList.remove('active-blue');
    badge.classList.remove('visible');
    if (state.track?.getCapabilities) {
      const caps = state.track.getCapabilities();
      try {
        if (caps.focusMode?.includes('continuous'))
          await state.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      } catch(e) {}
    }
    showToast('Macro desactivado', '');
  }
}

// ── HISTOGRAMA EN TIEMPO REAL ─────────────────────────────
let _histInterval = null;
function startHistogramLoop() {
  if (_histInterval) return;
  _histInterval = setInterval(drawHistogram, 500);
}

function drawHistogram() {
  if (!state.showHistogram) return;
  if (!state.showHistogram || !histCtx || !video.videoWidth) return;

  // Capturar frame pequeño para análisis
  const W = 48, H = 27;
  canvas.width = W; canvas.height = H;
  ctx.drawImage(video, 0, 0, W, H);
  let data;
  try { data = ctx.getImageData(0, 0, W, H).data; } catch(e) { return; }

  const hist = new Array(32).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round((0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]) / 8);
    if (lum < 32) hist[lum]++;
  }
  const maxH = Math.max(...hist) || 1;

  const cW = histCanvas.width, cH = histCanvas.height;
  histCtx.clearRect(0, 0, cW, cH);

  const bw = cW / 32;
  for (let i = 0; i < 32; i++) {
    const barH = (hist[i] / maxH) * (cH - 2);
    // Color: azul=sombras, verde=medios, rojo=altas luces
    const t = i / 31;
    const r = Math.round(t * 255);
    const g = Math.round(Math.sin(t * Math.PI) * 200);
    const b = Math.round((1 - t) * 255);
    histCtx.fillStyle = `rgba(${r},${g},${b},0.85)`;
    histCtx.fillRect(i * bw, cH - barH, bw - 0.5, barH);
  }

  // Línea de recorte en altas luces
  if (hist[31] > maxH * 0.3) {
    histCtx.strokeStyle = 'rgba(255,69,58,0.8)';
    histCtx.lineWidth = 1;
    histCtx.beginPath();
    histCtx.moveTo(cW - bw, 0);
    histCtx.lineTo(cW, 0);
    histCtx.stroke();
  }
}

// ── MODO GUIADO ───────────────────────────────────────────
function analyzeFrame() {
  if (!state.guidedShot || !video.videoWidth) return;
  const W = 40, H = 25;
  canvas.width = W; canvas.height = H;
  ctx.drawImage(video, 0, 0, W, H);
  let data;
  try { data = ctx.getImageData(0, 0, W, H).data; } catch(e) { return; }

  let totalLum = 0, lumL = 0, lumR = 0, wX = 0, wY = 0, totalW = 0;
  const px = data.length / 4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i   = (y * W + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      totalLum += lum;
      if (x < W / 3) lumL += lum; else if (x > W * 2/3) lumR += lum;
      if (lum < (totalLum / (px || 1)) - 20) { const w = 1; wX += x * w; wY += y * w; totalW += w; }
    }
  }
  const avg = totalLum / px;
  const tips = [];
  if (avg < 60)  tips.push({ icon: '💡', msg: 'Poca luz' });
  if (avg > 220) tips.push({ icon: '☀️', msg: 'Sobreexpuesto' });
  if (Math.abs(lumL - lumR) > 60 * (H * W / 3)) tips.push({ icon: '🌑', msg: 'Sombras asimétricas' });
  if (totalW > 0) {
    const cx = (wX / totalW) / W, cy = (wY / totalW) / H;
    if (cx < 0.28 || cx > 0.72) tips.push({ icon: '↔️', msg: 'Centra el producto' });
    if (cy < 0.28 || cy > 0.72) tips.push({ icon: '↕️', msg: 'Ajusta la altura' });
  }
  const cont = $('guided-tips');
  if (!cont) return;
  cont.innerHTML = tips.length === 0
    ? '<span class="tip ok">✅ Encuadre correcto</span>'
    : tips.map(t => `<span class="tip warn">${t.icon} ${t.msg}</span>`).join('');
  const vf = $('viewfinder');
  vf.classList.toggle('guided-ok',   tips.length === 0 && avg >= 60 && avg <= 220);
  vf.classList.toggle('guided-warn', tips.length > 0);
}

let _guidedInterval = null;
function startGuidedAnalysis() { stopGuidedAnalysis(); _guidedInterval = setInterval(analyzeFrame, 800); }
function stopGuidedAnalysis()  {
  clearInterval(_guidedInterval); _guidedInterval = null;
  const vf = $('viewfinder');
  vf?.classList.remove('guided-ok','guided-warn');
  const c = $('guided-tips'); if (c) c.innerHTML = '';
}

// ── CAPTURA ───────────────────────────────────────────────
async function takePhoto() {
  const code = $('product-input').value.trim();
  if (!code) { showToast('⚠️ Escribe el código del producto', 'warn'); $('product-input').focus(); return; }

  const count = (state.savedFiles[code] || 0) + 1;
  state.savedFiles[code] = count;

  const ext = state.format === 'image/jpeg' ? 'jpeg'
            : state.format === 'image/png'  ? 'png' : 'webp';
  const filename = `${code}-${count}.${ext}`;

  const fo = $('flash-overlay');
  fo.style.transition = 'none'; fo.style.opacity = '0.75';
  setTimeout(() => { fo.style.transition = 'opacity 0.15s'; fo.style.opacity = '0'; }, 80);

  const btnC = $('btn-capture');
  btnC.classList.add('capturing');
  setTimeout(() => btnC.classList.remove('capturing'), 200);

  try {
    let blob;
    if (state.imageCapture) {
      try {
        blob = await state.imageCapture.takePhoto({
          fillLightMode: state.flashOn ? 'flash' : 'off',
          imageWidth: 4000, imageHeight: 3000,
        });
      } catch(e) { blob = null; }
    }
    if (!blob) blob = await captureFromVideo();

    const processed = await processImage(blob);
    downloadBlob(processed, filename);

    state.photoCount++;
    $('photo-count').textContent  = state.photoCount;
    $('product-counter').textContent = count;

    const thumbUrl = URL.createObjectURL(processed);
    if (state.lastThumbUrl) URL.revokeObjectURL(state.lastThumbUrl);
    state.lastThumbUrl = thumbUrl;
    const thumb = $('last-thumb');
    thumb.src = thumbUrl; thumb.classList.add('visible');
    thumb.dataset.name = filename;

    showToast(`✓ ${filename}`, 'ok');
  } catch(err) {
    showToast('Error: ' + err.message, 'warn');
  }
}

function captureFromVideo() {
  return new Promise(resolve => {
    const vw = video.videoWidth || 1920, vh = video.videoHeight || 1080;
    canvas.width = vw; canvas.height = vh;
    ctx.drawImage(video, 0, 0, vw, vh);
    canvas.toBlob(resolve, state.format, state.quality);
  });
}

async function processImage(inputBlob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(inputBlob);
    img.onload = () => {
      try {
        const W = state.width, H = state.height;
        canvas.width = W; canvas.height = H;
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);

        const srcR = img.width / img.height, dstR = W / H;
        let dw, dh, dx, dy;
        if (srcR > dstR) { dw = W; dh = W / srcR; dx = 0; dy = (H - dh) / 2; }
        else              { dh = H; dw = H * srcR; dx = (W - dw) / 2; dy = 0; }
        ctx.drawImage(img, dx, dy, dw, dh);
        URL.revokeObjectURL(url);

        let iData = ctx.getImageData(0, 0, W, H);
        if (state.whiteBg) iData = cleanWhiteBackground(iData);
        if (state.sharpen)  iData = applySharpen(iData, W, H);
        iData = autoLevels(iData);
        ctx.putImageData(iData, 0, 0);

        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob falló')), state.format, state.quality);
      } catch(e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Error cargando imagen'));
    img.src = url;
  });
}

// ── FONDO BLANCO ──────────────────────────────────────────
function cleanWhiteBackground(imageData) {
  const data = imageData.data, len = data.length;
  const W = imageData.width, H = imageData.height;
  const borderSamples = [];
  const border = 20;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (x < border || x > W - border || y < border || y > H - border) {
        const i = (y * W + x) * 4;
        borderSamples.push(0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]);
      }
    }
  }
  borderSamples.sort((a, b) => b - a);
  const bgRef = borderSamples[Math.floor(borderSamples.length * 0.4)] || 200;
  const threshold = Math.max(180, bgRef - 40);

  for (let i = 0; i < len; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
    const sat = max === 0 ? 0 : (max - min) / max;
    if (lum >= threshold && sat < 0.15) {
      const blend = Math.min(1, (lum - threshold + 30) / 30);
      data[i]   = Math.round(r + (255 - r) * blend);
      data[i+1] = Math.round(g + (255 - g) * blend);
      data[i+2] = Math.round(b + (255 - b) * blend);
    }
  }
  return imageData;
}

// ── SHARPEN ───────────────────────────────────────────────
function applySharpen(imageData, W, H) {
  const src = new Uint8ClampedArray(imageData.data), dst = imageData.data;
  const k = [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let ky = -1; ky <= 1; ky++)
          for (let kx = -1; kx <= 1; kx++)
            v += src[((y+ky)*W+(x+kx))*4+c] * k[(ky+1)*3+(kx+1)];
        dst[i+c] = Math.max(0, Math.min(255, v));
      }
    }
  }
  return imageData;
}

// ── AUTO LEVELS ───────────────────────────────────────────
function autoLevels(imageData) {
  const data = imageData.data, len = data.length;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < len; i += 4)
    hist[Math.round(0.299*data[i]+0.587*data[i+1]+0.114*data[i+2])]++;
  const px = len / 4, clip = px * 0.01;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= clip) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= clip) { hi = v; break; } }
  if (hi <= lo || (hi - lo) > 200) return imageData;
  const scale = 255 / (hi - lo);
  const lut = Uint8ClampedArray.from({length:256}, (_, v) => Math.max(0, Math.min(255, Math.round((v-lo)*scale))));
  for (let i = 0; i < len; i += 4) { data[i]=lut[data[i]]; data[i+1]=lut[data[i+1]]; data[i+2]=lut[data[i+2]]; }
  return imageData;
}

// ── DESCARGA ──────────────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── FLASH ─────────────────────────────────────────────────
function toggleFlash() {
  state.flashOn = !state.flashOn;
  $('btn-flash').classList.toggle('active-yellow', state.flashOn);
  if (state.track) state.track.applyConstraints({ advanced: [{ torch: state.flashOn }] }).catch(()=>{});
}

// ── BLOQUEO / DESBLOQUEO ─────────────────────────────────
function toggleLock() {
  state.locked = !state.locked;
  applyLockUI();
}

function applyLockUI() {
  const badge   = $('locked-badge');
  const unlock  = $('btn-unlock');
  const lockBtn = $('btn-lock');
  const sliders = document.querySelectorAll('#slider-panel input[type=range]');

  if (state.locked) {
    badge.classList.add('visible');
    unlock.classList.add('visible');
    lockBtn.textContent = '🔒';
    lockBtn.classList.add('active-yellow');
    sliders.forEach(s => s.disabled = true);
    closePanel();
    showToast('🔒 Ajustes bloqueados', 'warn');
  } else {
    badge.classList.remove('visible');
    unlock.classList.remove('visible');
    lockBtn.textContent = '🔓';
    lockBtn.classList.remove('active-yellow');
    sliders.forEach(s => s.disabled = false);
    showToast('🔓 Ajustes desbloqueados', 'ok');
  }
}

// Desbloquear tocando el badge o el botón flotante
function unlockFromBadge() {
  if (state.locked) { state.locked = false; applyLockUI(); }
}
window.unlockFromBadge = unlockFromBadge;

// ── PANEL ─────────────────────────────────────────────────
function openPanel(name) {
  const panel = $('slider-panel');
  const titles = { ev: 'Exposición', wb: 'Balance de blancos', iso: 'ISO', zoom: 'Zoom' };
  if (state.currentPanel === name) { closePanel(); return; }
  state.currentPanel = name;
  $('panel-title').textContent = titles[name] || name;
  document.querySelectorAll('.control-row').forEach(r => {
    r.style.display = (!r.dataset.panel || r.dataset.panel === name) ? 'flex' : 'none';
  });
  document.querySelectorAll('.preset-row').forEach(r => {
    const parent = r.previousElementSibling;
    r.style.display = (parent?.dataset.panel === name) ? 'flex' : 'none';
  });
  panel.classList.add('open');
  document.querySelectorAll('.qc-btn[data-panel]').forEach(b =>
    b.classList.toggle('active', b.dataset.panel === name));
}

function closePanel() {
  $('slider-panel').classList.remove('open');
  state.currentPanel = null;
  document.querySelectorAll('.qc-btn').forEach(b => b.classList.remove('active'));
}

// ── PANTALLAS ─────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ── LABELS ────────────────────────────────────────────────
function updateQuickLabels() {
  const s = state.ev >= 0 ? '+' : '';
  $('ev-label').textContent   = s + state.ev.toFixed(1);
  $('iso-label').textContent  = ISO_VALS[state.iso] || 'Auto';
  $('zoom-label').textContent = state.zoom.toFixed(1) + '×';
  const wbe = Object.values(WB_PRESETS).find(p => p.k === state.wb);
  $('wb-label').textContent = wbe ? wbe.label : (state.wb + 'K');

  $('sl-ev').value   = state.ev;
  $('sl-wb').value   = state.wb || 5500;
  $('sl-iso').value  = state.iso;
  $('sl-zoom').value = state.zoom;

  $('sl-ev-val').textContent   = s + state.ev.toFixed(1);
  $('sl-wb-val').textContent   = state.wb === 0 ? 'Auto' : state.wb + 'K';
  $('sl-iso-val').textContent  = ISO_VALS[state.iso] || 'Auto';
  $('sl-zoom-val').textContent = state.zoom.toFixed(1) + '×';
  updateZoomIndicator();
}

// ── AJUSTES ───────────────────────────────────────────────
function applySettingsUI() {
  $('set-format').value  = state.format;
  $('set-width').value   = state.width;
  $('set-height').value  = state.height;
  $('set-quality').value = Math.round(state.quality * 100);
  $('quality-desc').textContent = Math.round(state.quality * 100) + '%';
  setToggle('tog-autonumber', state.autoNumber);
  setToggle('tog-white-bg',   state.whiteBg);
  setToggle('tog-sharpen',    state.sharpen);
  setToggle('tog-guided',     state.guidedShot);
  $('grid-overlay').classList.toggle('visible', state.showGrid);
  $('histogram-overlay').classList.toggle('visible', state.showHistogram);
}

function setToggle(id, val) {
  const el = $(id); if (!el) return;
  val ? el.classList.add('on') : el.classList.remove('on');
}

function saveSettings() {
  try {
    localStorage.setItem('fotopro_v3', JSON.stringify({
      format: state.format, width: state.width, height: state.height,
      quality: state.quality, autoNumber: state.autoNumber,
      whiteBg: state.whiteBg, sharpen: state.sharpen,
      guidedShot: state.guidedShot, ev: state.ev, wb: state.wb,
      iso: state.iso, zoom: state.zoom, showGrid: state.showGrid,
      showHistogram: state.showHistogram, frontCam: state.frontCam,
    }));
  } catch(e) {}
}

function loadSettings() {
  try {
    const r = localStorage.getItem('fotopro_v3');
    if (r) Object.assign(state, JSON.parse(r));
  } catch(e) {}
}

// ── TOAST ─────────────────────────────────────────────────
let _toastTimer;
function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = 'show' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── EVENTOS ───────────────────────────────────────────────
function bindEvents() {
  // Viewfinder
  $('viewfinder').addEventListener('click', handleTapFocus);
  $('viewfinder').addEventListener('touchstart', handlePinchStart, { passive: false });
  $('viewfinder').addEventListener('touchmove',  handlePinchMove,  { passive: false });
  $('viewfinder').addEventListener('touchend',   handlePinchEnd);

  // Cerrar panel al tocar viewfinder
  // Panel se cierra via closePanel() llamado desde openPanel() cuando se toca el mismo panel

  // Botones acción
  $('btn-capture').addEventListener('click', () => { if (!state.timerRunning) runTimerThenShoot(); });
  $('btn-capture').addEventListener('touchend', e => { e.preventDefault(); if (!state.timerRunning) runTimerThenShoot(); });
  $('btn-flash').addEventListener('click', toggleFlash);
  $('btn-timer').addEventListener('click', cycleTimer);
  $('btn-lock').addEventListener('click', toggleLock);
  $('btn-flip').addEventListener('click', () => {
    state.frontCam = !state.frontCam;
    $('btn-flip').classList.toggle('active-blue', state.frontCam);
    startCamera();
  });
  $('btn-settings').addEventListener('click', () => { closePanel(); showScreen('settings'); });
  $('btn-back').addEventListener('click', () => {
    showScreen('cam'); saveSettings(); applySettingsUI(); startCamera();
  });

  // Controles rápidos
  document.querySelectorAll('.qc-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (state.locked) { showToast('🔒 Ajustes bloqueados', 'warn'); return; }
      openPanel(btn.dataset.panel);
    });
  });

  $('qc-grid').addEventListener('click', () => {
    state.showGrid = !state.showGrid;
    $('grid-overlay').classList.toggle('visible', state.showGrid);
    $('qc-grid').classList.toggle('active', state.showGrid);
    saveSettings();
  });
  $('qc-hist').addEventListener('click', () => {
    state.showHistogram = !state.showHistogram;
    $('histogram-overlay').classList.toggle('visible', state.showHistogram);
    $('qc-hist').classList.toggle('active', state.showHistogram);
    saveSettings();
  });
  $('qc-macro').addEventListener('click', toggleMacro);

  // Sliders
  $('sl-ev').addEventListener('input', async e => {
    state.ev = parseFloat(e.target.value); updateQuickLabels(); await applyManualControls();
  });
  $('sl-wb').addEventListener('input', async e => {
    state.wb = parseInt(e.target.value); updateQuickLabels(); await applyManualControls();
  });
  $('sl-iso').addEventListener('input', async e => {
    state.iso = parseInt(e.target.value); updateQuickLabels(); await applyManualControls();
  });
  $('sl-zoom').addEventListener('input', async e => {
    state.zoom = parseFloat(e.target.value); updateQuickLabels(); await applyManualControls();
  });

  // Presets EV
  document.querySelectorAll('[data-ev-preset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const p = EV_PRESETS[btn.dataset.evPreset]; if (!p) return;
      state.ev = p.ev; $('sl-ev').value = state.ev; updateQuickLabels(); await applyManualControls();
      document.querySelectorAll('[data-ev-preset]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Presets WB
  document.querySelectorAll('[data-wb-preset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const p = WB_PRESETS[btn.dataset.wbPreset]; if (!p) return;
      state.wb = p.k; $('sl-wb').value = state.wb || 5500; updateQuickLabels(); await applyManualControls();
      document.querySelectorAll('[data-wb-preset]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Ajustes
  $('set-format').addEventListener('change', e => { state.format = e.target.value; });
  $('set-width').addEventListener('input',   e => { state.width  = parseInt(e.target.value) || 1200; });
  $('set-height').addEventListener('input',  e => { state.height = parseInt(e.target.value) || 1200; });
  $('set-quality').addEventListener('input', e => {
    state.quality = parseInt(e.target.value) / 100;
    $('quality-desc').textContent = e.target.value + '%';
  });
  toggleSetup('tog-autonumber', 'autoNumber');
  toggleSetup('tog-white-bg', 'whiteBg');
  toggleSetup('tog-sharpen', 'sharpen');
  toggleSetup('tog-guided', 'guidedShot', () => {
    if (state.guidedShot) startGuidedAnalysis(); else stopGuidedAnalysis();
  });

  // Input código
  $('product-input').addEventListener('input', () => {
    const code = $('product-input').value.trim();
    $('product-counter').textContent = state.savedFiles[code] || 0;
  });
  $('product-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); runTimerThenShoot(); }
  });

  // Teclas volumen / espacio
  document.addEventListener('keydown', e => {
    if ((e.key === 'VolumeDown' || e.key === 'VolumeUp' || e.key === ' ')
        && screens.cam.classList.contains('active')
        && document.activeElement !== $('product-input')) {
      e.preventDefault(); runTimerThenShoot();
    }
  });

  // Miniatura → vista previa
  $('last-thumb').addEventListener('click', e => {
    e.stopPropagation();
    if (!state.lastThumbUrl) return;
    $('preview-img').src = state.lastThumbUrl;
    $('preview-name').textContent = e.target.dataset.name || '';
    showScreen('preview');
  });
  $('btn-close-preview').addEventListener('click', () => showScreen('cam'));
}

function toggleSetup(id, key, extra) {
  const el = $(id); if (!el) return;
  el.addEventListener('click', () => {
    state[key] = !state[key]; setToggle(id, state[key]); if (extra) extra();
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
init();
