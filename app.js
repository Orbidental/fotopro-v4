'use strict';
// ═══════════════════════════════════════════════════════════════
//  FotoPro Productos v2.0 — Cámara profesional para ecommerce
//  Correcciones: nomenclatura, zoom real, enfoque, EV, WB,
//  fondo blanco, sharpen, modo guiado, pinch-to-zoom
// ═══════════════════════════════════════════════════════════════

// ── ESTADO ──────────────────────────────────────────────────────
const state = {
  stream: null,
  track: null,
  imageCapture: null,
  currentPanel: null,
  locked: false,
  flashOn: false,
  frontCam: false,

  // Controles manuales
  ev: 0,
  wb: 5500,      // 0 = auto WB
  iso: 0,        // 0 = auto
  zoom: 1.0,
  zoomMin: 1.0,
  zoomMax: 5.0,

  // Ajustes de salida
  format: 'image/jpeg',
  width: 1200,
  height: 1200,
  quality: 0.95,

  // Nomenclatura
  autoNumber: true,
  warnExists: true,
  showGrid: false,

  // Procesamiento
  whiteBg: false,
  sharpen: false,
  guidedShot: false,

  // Sesión actual
  photoCount: 0,
  savedFiles: {},
  lastThumbUrl: null,

  // Gestos pinch
  _pinchDist: null,
  _pinchZoomStart: null,

  // Enfoque
  _focusLockTimer: null,
  _focusLocked: false,
};

const ISO_VALS = ['Auto', 50, 100, 200, 400, 800, 1600];

const WB_PRESETS = {
  'auto':        { label: 'Auto',   k: 0    },
  'daylight':    { label: 'Sol',    k: 5500 },
  'cloudy':      { label: 'Nublado',k: 6500 },
  'fluorescent': { label: 'Fluor.', k: 4000 },
  'tungsten':    { label: 'Tungst.',k: 2800 },
};

const EV_PRESETS = {
  'auto':   { label: 'Auto',     ev: 0    },
  'light':  { label: 'Claro',    ev: 1.0  },
  'dark':   { label: 'Oscuro',   ev: -1.0 },
  'white':  { label: 'Fdo Blanco', ev: 1.3 },
};

// ── ELEMENTOS DOM ───────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = { cam: $('cam-screen'), settings: $('settings-screen'), preview: $('preview-screen') };
const video   = $('video');
const canvas  = $('canvas');
const ctx     = canvas.getContext('2d', { willReadFrequently: true });

// ── INIT ────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  await startCamera();
  bindEvents();
  applySettingsUI();
  updateQuickLabels();
}

// ── CÁMARA ──────────────────────────────────────────────────────
async function startCamera() {
  try {
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());

    const constraints = {
      video: {
        facingMode: state.frontCam ? 'user' : { ideal: 'environment' },
        width:  { ideal: 4096 },
        height: { ideal: 3072 },
        advanced: [{ zoom: 1 }],
      },
      audio: false,
    };

    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = state.stream;
    await video.play();

    state.track = state.stream.getVideoTracks()[0];

    if ('ImageCapture' in window) {
      state.imageCapture = new ImageCapture(state.track);
    }

    // Detectar rangos de zoom reales del dispositivo
    if (state.track.getCapabilities) {
      const caps = state.track.getCapabilities();
      if (caps.zoom) {
        state.zoomMin = caps.zoom.min || 1.0;
        state.zoomMax = caps.zoom.max || 5.0;
        $('sl-zoom').min  = state.zoomMin;
        $('sl-zoom').max  = state.zoomMax;
        $('sl-zoom').step = 0.1;
      }
    }

    state.zoom = state.zoomMin;
    $('sl-zoom').value = state.zoom;
    updateQuickLabels();

    await applyManualControls();
  } catch (err) {
    showToast('Error cámara: ' + err.message, 'warn');
    console.error(err);
  }
}

// ── CONTROLES MANUALES ─────────────────────────────────────────
async function applyManualControls() {
  if (!state.track || !state.track.getCapabilities) return;
  const caps = state.track.getCapabilities();
  const adv  = {};

  // ── Exposición / EV ──
  if (caps.exposureCompensation) {
    const min = caps.exposureCompensation.min ?? -3;
    const max = caps.exposureCompensation.max ?? 3;
    adv.exposureCompensation = Math.max(min, Math.min(max, state.ev));
    adv.exposureMode = 'continuous';
  }

  // ── Balance de blancos ──
  if (state.wb === 0) {
    // WB automático
    if (caps.whiteBalanceMode?.includes('continuous')) {
      adv.whiteBalanceMode = 'continuous';
    }
  } else {
    // WB manual por temperatura
    if (caps.colorTemperature) {
      const wbMin = caps.colorTemperature.min ?? 2500;
      const wbMax = caps.colorTemperature.max ?? 7500;
      adv.colorTemperature = Math.max(wbMin, Math.min(wbMax, state.wb));
      if (caps.whiteBalanceMode?.includes('manual')) {
        adv.whiteBalanceMode = 'manual';
      }
    }
  }

  // ── ISO ──
  if (caps.iso && state.iso > 0) {
    const isoVal = ISO_VALS[state.iso];
    if (typeof isoVal === 'number') {
      const iMin = caps.iso.min ?? 50;
      const iMax = caps.iso.max ?? 3200;
      adv.iso = Math.max(iMin, Math.min(iMax, isoVal));
      adv.exposureMode = 'manual';
    }
  }

  // ── Zoom real del hardware ──
  if (caps.zoom) {
    const zMin = caps.zoom.min ?? 1;
    const zMax = caps.zoom.max ?? 5;
    adv.zoom = Math.max(zMin, Math.min(zMax, state.zoom));
  }

  try {
    if (Object.keys(adv).length > 0) {
      await state.track.applyConstraints({ advanced: [adv] });
    }
  } catch (e) {
    console.warn('applyConstraints parcial:', e.message);
  }

  // Zoom por CSS como fallback si el hardware no lo soporta
  if (!caps.zoom && state.zoom > 1) {
    video.style.transform = `scale(${state.zoom})`;
    video.style.transformOrigin = 'center center';
  } else {
    video.style.transform = '';
  }

  updateZoomIndicator();
}

function updateZoomIndicator() {
  const ind = $('zoom-indicator');
  if (!ind) return;
  const z = state.zoom.toFixed(1);
  ind.textContent = z + '×';
  ind.classList.toggle('visible', state.zoom > state.zoomMin + 0.05);
}

// ── TAP TO FOCUS ───────────────────────────────────────────────
async function handleTapFocus(e) {
  if (state.locked) return;

  // No activar si el tap fue sobre controles superpuestos
  if (e.target !== $('viewfinder') && e.target !== video && e.target !== $('grid-overlay')) return;

  const rect = $('viewfinder').getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top)  / rect.height;

  // Mostrar anillo de enfoque
  const ring = $('focus-ring');
  ring.style.left = (x * 100) + '%';
  ring.style.top  = (y * 100) + '%';
  ring.classList.remove('visible', 'locked');
  ring.classList.add('visible', 'focusing');

  // Cancelar bloqueo anterior
  clearTimeout(state._focusLockTimer);
  state._focusLocked = false;

  // Aplicar punto de enfoque real
  if (state.track && state.track.getCapabilities) {
    const caps = state.track.getCapabilities();
    const adv  = {};

    if (caps.focusMode?.includes('manual')) {
      adv.focusMode = 'manual';
    } else if (caps.focusMode?.includes('single-shot')) {
      adv.focusMode = 'single-shot';
    }

    if (caps.pointsOfInterest) {
      adv.pointsOfInterest = [{ x, y }];
    }

    if (caps.focusDistance && caps.focusMode?.includes('manual')) {
      // Mantener distancia actual pero reapuntar
    }

    try {
      if (Object.keys(adv).length > 0) {
        await state.track.applyConstraints({ advanced: [adv] });
      }
    } catch (e) {}
  }

  // Feedback visual: anillo se "cierra" indicando foco conseguido
  setTimeout(() => {
    ring.classList.remove('focusing');
    ring.classList.add('locked');
    state._focusLocked = true;

    // Auto-desbloquear foco a los 3s para reenfoque automático
    state._focusLockTimer = setTimeout(async () => {
      ring.classList.remove('visible', 'locked');
      state._focusLocked = false;
      // Volver a AF continuo
      if (state.track?.getCapabilities) {
        const caps = state.track.getCapabilities();
        if (caps.focusMode?.includes('continuous')) {
          try {
            await state.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
          } catch(e) {}
        }
      }
    }, 3000);
  }, 600);
}

// ── PINCH TO ZOOM ──────────────────────────────────────────────
function getTouchDist(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function handlePinchStart(e) {
  if (e.touches.length === 2) {
    state._pinchDist      = getTouchDist(e.touches[0], e.touches[1]);
    state._pinchZoomStart = state.zoom;
    e.preventDefault();
  }
}

function handlePinchMove(e) {
  if (e.touches.length === 2 && state._pinchDist !== null) {
    e.preventDefault();
    const newDist  = getTouchDist(e.touches[0], e.touches[1]);
    const scale    = newDist / state._pinchDist;
    const newZoom  = Math.max(state.zoomMin, Math.min(state.zoomMax, state._pinchZoomStart * scale));
    state.zoom     = Math.round(newZoom * 10) / 10;
    $('sl-zoom').value = state.zoom;
    updateQuickLabels();
    applyManualControls();
  }
}

function handlePinchEnd() {
  state._pinchDist      = null;
  state._pinchZoomStart = null;
}

// ── CAPTURA ─────────────────────────────────────────────────────
async function takePhoto() {
  const code = $('product-input').value.trim();
  if (!code) {
    showToast('⚠️ Escribe el código del producto', 'warn');
    $('product-input').focus();
    return;
  }

  // ── NOMENCLATURA CORREGIDA ──
  // SIEMPRE formato: -NOMBRE-N  (guion inicial, número obligatorio desde foto 1)
  const prev  = state.savedFiles[code] || 0;
  const count = prev + 1;
  state.savedFiles[code] = count;

  const ext = state.format === 'image/jpeg' ? 'jpg'
            : state.format === 'image/png'  ? 'png' : 'webp';

  // Formato estricto: -CODIGO-1, -CODIGO-2, ...
  const filename = `-${code}-${count}.${ext}`;

  // Feedback visual
  const flashOverlay = $('flash-overlay');
  flashOverlay.style.opacity = '0.7';
  setTimeout(() => { flashOverlay.style.opacity = '0'; }, 120);

  const btnCapture = $('btn-capture');
  btnCapture.classList.add('capturing');
  setTimeout(() => btnCapture.classList.remove('capturing'), 200);

  try {
    let blob;

    // 1) Intentar ImageCapture de alta resolución
    if (state.imageCapture) {
      try {
        blob = await state.imageCapture.takePhoto({
          fillLightMode: state.flashOn ? 'flash' : 'off',
          imageWidth:  4000,
          imageHeight: 3000,
        });
      } catch (e) {
        blob = null;
      }
    }

    // 2) Fallback: frame del video
    if (!blob) blob = await captureFromVideo();

    // 3) Procesar imagen (redimensionar + fondo blanco + sharpen)
    const processedBlob = await processImage(blob);

    // 4) Descargar con nombre correcto
    downloadBlob(processedBlob, filename);

    // 5) Actualizar UI
    state.photoCount++;
    $('photo-count').textContent = state.photoCount;
    $('product-counter').textContent = count;

    const thumbUrl = URL.createObjectURL(processedBlob);
    if (state.lastThumbUrl) URL.revokeObjectURL(state.lastThumbUrl);
    state.lastThumbUrl = thumbUrl;
    const thumb = $('last-thumb');
    thumb.src = thumbUrl;
    thumb.classList.add('visible');
    thumb.dataset.name = filename;

    showToast(`✓ ${filename}`, 'ok');

  } catch (err) {
    showToast('Error captura: ' + err.message, 'warn');
    console.error(err);
  }
}

// Captura frame del video como blob
function captureFromVideo() {
  return new Promise((resolve) => {
    const vw = video.videoWidth  || 1920;
    const vh = video.videoHeight || 1080;
    canvas.width  = vw;
    canvas.height = vh;
    ctx.drawImage(video, 0, 0, vw, vh);
    canvas.toBlob(resolve, state.format, state.quality);
  });
}

// ── PROCESAMIENTO DE IMAGEN ─────────────────────────────────────
async function processImage(inputBlob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(inputBlob);

    img.onload = () => {
      try {
        const W = state.width;
        const H = state.height;
        canvas.width  = W;
        canvas.height = H;

        // Fondo blanco base
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);

        // Escalar con letterbox (fit, no cover) → no recorta el producto
        const srcRatio = img.width / img.height;
        const dstRatio = W / H;
        let dw, dh, dx, dy;

        if (srcRatio > dstRatio) {
          dw = W;
          dh = W / srcRatio;
          dx = 0;
          dy = (H - dh) / 2;
        } else {
          dh = H;
          dw = H * srcRatio;
          dx = (W - dw) / 2;
          dy = 0;
        }

        ctx.drawImage(img, dx, dy, dw, dh);
        URL.revokeObjectURL(url);

        // Aplicar procesamiento de píxeles
        let imageData = ctx.getImageData(0, 0, W, H);

        if (state.whiteBg) imageData = cleanWhiteBackground(imageData);
        if (state.sharpen)  imageData = applySharpen(imageData, W, H);

        // Corrección automática de brillo/contraste
        imageData = autoLevels(imageData);

        ctx.putImageData(imageData, 0, 0);

        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error('toBlob falló'));
        }, state.format, state.quality);

      } catch(e) {
        reject(e);
      }
    };

    img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
    img.src = url;
  });
}

// ── FONDO BLANCO PROFESIONAL ─────────────────────────────────────
// Detecta píxeles de fondo (grises, blancos sucios) y los lleva a blanco puro.
// Preserva el producto usando análisis de luminosidad y saturación.
function cleanWhiteBackground(imageData) {
  const data = imageData.data;
  const len  = data.length;

  // Primer paso: detectar el umbral del fondo midiendo el cuartil superior
  // de luminosidad en los bordes de la imagen
  const W = imageData.width;
  const H = imageData.height;

  // Muestra los píxeles del borde exterior para calibrar el fondo
  const borderSamples = [];
  const border = 20; // px
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (x < border || x > W - border || y < border || y > H - border) {
        const i = (y * W + x) * 4;
        const r = data[i], g = data[i+1], b = data[i+2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        borderSamples.push(lum);
      }
    }
  }

  borderSamples.sort((a, b) => b - a);
  // Usar el percentil 60 del borde como referencia de "fondo"
  const bgRef = borderSamples[Math.floor(borderSamples.length * 0.4)] || 200;
  const threshold = Math.max(180, bgRef - 40);

  for (let i = 0; i < len; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    // Saturación aproximada (HSL)
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const sat = max === 0 ? 0 : (max - min) / max;

    // Es fondo si: muy luminoso Y baja saturación
    if (lum >= threshold && sat < 0.15) {
      // Blend suave hacia blanco puro basado en proximidad al umbral
      const blend = Math.min(1, (lum - threshold + 30) / 30);
      data[i]   = Math.round(r + (255 - r) * blend);
      data[i+1] = Math.round(g + (255 - g) * blend);
      data[i+2] = Math.round(b + (255 - b) * blend);
    }
  }

  return imageData;
}

// ── SHARPEN INTELIGENTE ─────────────────────────────────────────
// Kernel de unsharp mask 3×3 moderado
function applySharpen(imageData, W, H) {
  const src = new Uint8ClampedArray(imageData.data);
  const dst = imageData.data;

  // Kernel unsharp mask leve para preservar colores naturales
  const kernel = [
     0, -0.5,    0,
    -0.5,  3,  -0.5,
     0, -0.5,    0,
  ];

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;

      for (let c = 0; c < 3; c++) {
        let val = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const ni = ((y + ky) * W + (x + kx)) * 4;
            val += src[ni + c] * kernel[(ky + 1) * 3 + (kx + 1)];
          }
        }
        dst[i + c] = Math.max(0, Math.min(255, val));
      }
    }
  }

  return imageData;
}

// ── AUTO LEVELS (corrección brillo/contraste) ───────────────────
function autoLevels(imageData) {
  const data = imageData.data;
  const len  = data.length;

  // Histograma de luminosidad
  let minL = 255, maxL = 0;
  for (let i = 0; i < len; i += 4) {
    const lum = Math.round(0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]);
    if (lum < minL) minL = lum;
    if (lum > maxL) maxL = lum;
  }

  // Stretch moderado: solo ajustar si el rango es muy estrecho
  const range = maxL - minL;
  if (range < 30) return imageData; // imagen muy plana, ignorar
  if (range > 200) return imageData; // ya bien contrastada

  // Recortar el 1% superior e inferior
  const hist = new Array(256).fill(0);
  for (let i = 0; i < len; i += 4) {
    const lum = Math.round(0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]);
    hist[lum]++;
  }
  const pixels = len / 4;
  const clip   = pixels * 0.01;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= clip) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= clip) { hi = v; break; } }

  if (hi <= lo) return imageData;

  const scale = 255 / (hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.max(0, Math.min(255, Math.round((v - lo) * scale)));
  }

  for (let i = 0; i < len; i += 4) {
    data[i]   = lut[data[i]];
    data[i+1] = lut[data[i+1]];
    data[i+2] = lut[data[i+2]];
  }

  return imageData;
}

// ── DESCARGA ────────────────────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── MODO GUIADO ────────────────────────────────────────────────
// Analiza el frame del video para detectar problemas de composición
function analyzeFrame() {
  if (!state.guidedShot) return;
  if (!video.videoWidth) return;

  const W = Math.floor(video.videoWidth  / 4); // Reducir para performance
  const H = Math.floor(video.videoHeight / 4);

  canvas.width  = W;
  canvas.height = H;
  ctx.drawImage(video, 0, 0, W, H);

  const iData = ctx.getImageData(0, 0, W, H);
  const data  = iData.data;

  const tips = [];

  // ── Análisis de iluminación ──
  let totalLum = 0;
  for (let i = 0; i < data.length; i += 4) {
    totalLum += 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
  }
  const avgLum = totalLum / (data.length / 4);

  if (avgLum < 60)  tips.push({ icon: '💡', msg: 'Poca luz — acerca una fuente de luz' });
  if (avgLum > 220) tips.push({ icon: '☀️', msg: 'Sobreexpuesto — reduce la luz o el EV' });

  // ── Análisis de sombras duras ──
  // Comparar luminosidad del tercio izquierdo vs derecho
  let lumLeft = 0, lumRight = 0, cnt = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i   = (y * W + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      if (x < W / 3)      { lumLeft  += lum; cnt++; }
      else if (x > W * 2/3) { lumRight += lum; cnt++; }
    }
  }
  lumLeft  /= (cnt / 2);
  lumRight /= (cnt / 2);
  if (Math.abs(lumLeft - lumRight) > 60) {
    tips.push({ icon: '🌑', msg: 'Sombras asimétricas — mejora el relleno de luz' });
  }

  // ── Análisis de producto centrado ──
  // Detectar masa oscura (producto probable) vs fondo claro
  let weightX = 0, weightY = 0, totalW = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i   = (y * W + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      // Píxeles oscuros (probablemente producto)
      if (lum < avgLum - 20) {
        const w = (avgLum - lum) / avgLum;
        weightX += x * w;
        weightY += y * w;
        totalW  += w;
      }
    }
  }

  if (totalW > 0) {
    const cx = (weightX / totalW) / W;
    const cy = (weightY / totalW) / H;

    if (cx < 0.3 || cx > 0.7) tips.push({ icon: '↔️', msg: 'Producto fuera de centro horizontal' });
    if (cy < 0.3 || cy > 0.7) tips.push({ icon: '↕️', msg: 'Producto fuera de centro vertical'   });
  }

  // ── Actualizar indicadores guiados ──
  updateGuidedTips(tips, avgLum);
}

function updateGuidedTips(tips, avgLum) {
  const container = $('guided-tips');
  if (!container) return;

  if (tips.length === 0) {
    container.innerHTML = '<span class="tip ok">✅ Composición correcta</span>';
  } else {
    container.innerHTML = tips
      .map(t => `<span class="tip warn">${t.icon} ${t.msg}</span>`)
      .join('');
  }

  // Color del borde del visor según estado
  const vf = $('viewfinder');
  if (tips.length === 0 && avgLum >= 60 && avgLum <= 220) {
    vf.classList.add('guided-ok');
    vf.classList.remove('guided-warn');
  } else {
    vf.classList.remove('guided-ok');
    vf.classList.add(tips.length > 0 ? 'guided-warn' : '');
  }
}

// Loop de análisis a 3 fps para no quemar CPU
let _guidedInterval = null;
function startGuidedAnalysis() {
  stopGuidedAnalysis();
  _guidedInterval = setInterval(analyzeFrame, 333);
}
function stopGuidedAnalysis() {
  clearInterval(_guidedInterval);
  _guidedInterval = null;
  const vf = $('viewfinder');
  if (vf) vf.classList.remove('guided-ok', 'guided-warn');
  const container = $('guided-tips');
  if (container) container.innerHTML = '';
}

// ── FLASH / LINTERNA ───────────────────────────────────────────
function toggleFlash() {
  state.flashOn = !state.flashOn;
  const btn = $('btn-flash');
  btn.classList.toggle('on', state.flashOn);
  applyTorch(state.flashOn);
}

async function applyTorch(on) {
  if (!state.track) return;
  try {
    await state.track.applyConstraints({ advanced: [{ torch: on }] });
  } catch (e) {}
}

// ── PANEL DESLIZABLE ───────────────────────────────────────────
function openPanel(name) {
  const panel = $('slider-panel');
  if (state.currentPanel === name) {
    panel.classList.remove('open');
    state.currentPanel = null;
    document.querySelectorAll('.qc-btn').forEach(b => b.classList.remove('active'));
    return;
  }
  state.currentPanel = name;

  // Mostrar/ocultar filas relevantes
  document.querySelectorAll('.control-row').forEach(r => {
    r.style.display = (r.dataset.panel === name || !r.dataset.panel) ? 'flex' : 'none';
  });

  panel.classList.add('open');
  document.querySelectorAll('.qc-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector(`[data-panel="${name}"]`);
  if (activeBtn) activeBtn.classList.add('active');
}

function closePanel() {
  $('slider-panel').classList.remove('open');
  state.currentPanel = null;
  document.querySelectorAll('.qc-btn').forEach(b => b.classList.remove('active'));
}

// ── LABELS ─────────────────────────────────────────────────────
function updateQuickLabels() {
  const evSign = state.ev >= 0 ? '+' : '';
  $('ev-label').textContent  = evSign + state.ev.toFixed(1);
  $('iso-label').textContent = ISO_VALS[state.iso] || 'Auto';
  $('zoom-label').textContent = state.zoom.toFixed(1) + '×';

  // WB label
  const wbEntry = Object.values(WB_PRESETS).find(p => p.k === state.wb);
  $('wb-label').textContent = wbEntry ? wbEntry.label : (state.wb + 'K');

  // Slider sync
  $('sl-ev').value   = state.ev;
  $('sl-wb').value   = state.wb === 0 ? 5500 : state.wb;
  $('sl-iso').value  = state.iso;
  $('sl-zoom').value = state.zoom;

  $('sl-ev-val').textContent   = evSign + state.ev.toFixed(1);
  $('sl-wb-val').textContent   = state.wb === 0 ? 'Auto' : (state.wb + 'K');
  $('sl-iso-val').textContent  = ISO_VALS[state.iso] || 'Auto';
  $('sl-zoom-val').textContent = state.zoom.toFixed(1) + '×';

  updateZoomIndicator();
}

// ── BLOQUEO ────────────────────────────────────────────────────
function toggleLock() {
  state.locked = !state.locked;
  const btn    = $('btn-lock-controls');
  const badge  = $('locked-badge');
  const sliders = document.querySelectorAll('#slider-panel input[type=range]');

  if (state.locked) {
    btn.textContent = '🔒 Ajustes bloqueados';
    btn.classList.add('locked');
    badge.classList.add('visible');
    sliders.forEach(s => s.disabled = true);
    closePanel();
  } else {
    btn.textContent = '🔓 Bloquear ajustes';
    btn.classList.remove('locked');
    badge.classList.remove('visible');
    sliders.forEach(s => s.disabled = false);
  }
}

// ── PANTALLAS ──────────────────────────────────────────────────
function showScreen(name) {
  Object.keys(screens).forEach(k => screens[k].classList.remove('active'));
  screens[name].classList.add('active');
}

// ── AJUSTES ────────────────────────────────────────────────────
function applySettingsUI() {
  $('set-format').value   = state.format;
  $('set-width').value    = state.width;
  $('set-height').value   = state.height;
  $('set-quality').value  = Math.round(state.quality * 100);
  $('quality-desc').textContent = Math.round(state.quality * 100) + '%';

  setToggle('tog-autonumber', state.autoNumber);
  setToggle('tog-warn-exists', state.warnExists);
  setToggle('tog-grid',       state.showGrid);
  setToggle('tog-front-cam',  state.frontCam);
  setToggle('tog-white-bg',   state.whiteBg);
  setToggle('tog-sharpen',    state.sharpen);
  setToggle('tog-guided',     state.guidedShot);

  $('grid-overlay').classList.toggle('visible', state.showGrid);

  $('sl-ev').value   = state.ev;
  $('sl-wb').value   = state.wb === 0 ? 5500 : state.wb;
  $('sl-iso').value  = state.iso;
  $('sl-zoom').value = state.zoom;
  updateQuickLabels();
}

function setToggle(id, val) {
  const el = $(id);
  if (!el) return;
  val ? el.classList.add('on') : el.classList.remove('on');
}

function saveSettings() {
  const s = {
    format: state.format, width: state.width, height: state.height,
    quality: state.quality, autoNumber: state.autoNumber,
    warnExists: state.warnExists, showGrid: state.showGrid,
    frontCam: state.frontCam, ev: state.ev, wb: state.wb,
    iso: state.iso, zoom: state.zoom, whiteBg: state.whiteBg,
    sharpen: state.sharpen, guidedShot: state.guidedShot,
  };
  try { localStorage.setItem('fotopro_v2', JSON.stringify(s)); } catch(e) {}
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('fotopro_v2');
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch(e) {}
}

// ── TOAST ──────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── EVENTOS ────────────────────────────────────────────────────
function bindEvents() {

  // Tap to focus en el viewfinder
  $('viewfinder').addEventListener('click', handleTapFocus);

  // Pinch to zoom
  $('viewfinder').addEventListener('touchstart', handlePinchStart, { passive: false });
  $('viewfinder').addEventListener('touchmove',  handlePinchMove,  { passive: false });
  $('viewfinder').addEventListener('touchend',   handlePinchEnd);

  // Botones principales
  $('btn-capture').addEventListener('click', takePhoto);
  $('btn-flash').addEventListener('click', toggleFlash);
  $('btn-settings').addEventListener('click', () => {
    closePanel();
    showScreen('settings');
  });

  // Volver de ajustes
  $('btn-back').addEventListener('click', () => {
    showScreen('cam');
    saveSettings();
    applySettingsUI();
    startCamera(); // reinicia si cambió cámara frontal/trasera
  });

  // Controles rápidos
  document.querySelectorAll('.qc-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.locked) { showToast('🔒 Ajustes bloqueados'); return; }
      openPanel(btn.dataset.panel);
    });
  });

  // Grilla
  $('qc-grid').addEventListener('click', () => {
    state.showGrid = !state.showGrid;
    $('grid-overlay').classList.toggle('visible', state.showGrid);
    $('qc-grid').classList.toggle('active', state.showGrid);
    saveSettings();
  });

  // Cerrar panel al tocar el viewfinder (solo si hay panel abierto)
  $('viewfinder').addEventListener('click', (e) => {
    if (state.currentPanel) {
      closePanel();
      e.stopPropagation();
    }
  }, true);

  // ── Sliders ──
  $('sl-ev').addEventListener('input', async (e) => {
    state.ev = parseFloat(e.target.value);
    updateQuickLabels();
    await applyManualControls();
  });

  $('sl-wb').addEventListener('input', async (e) => {
    state.wb = parseInt(e.target.value);
    updateQuickLabels();
    await applyManualControls();
  });

  $('sl-iso').addEventListener('input', async (e) => {
    state.iso = parseInt(e.target.value);
    updateQuickLabels();
    await applyManualControls();
  });

  $('sl-zoom').addEventListener('input', async (e) => {
    state.zoom = parseFloat(e.target.value);
    updateQuickLabels();
    await applyManualControls();
  });

  // ── Presets EV ──
  document.querySelectorAll('[data-ev-preset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const preset = EV_PRESETS[btn.dataset.evPreset];
      if (preset) {
        state.ev = preset.ev;
        $('sl-ev').value = state.ev;
        updateQuickLabels();
        await applyManualControls();
        document.querySelectorAll('[data-ev-preset]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });

  // ── Presets WB ──
  document.querySelectorAll('[data-wb-preset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const preset = WB_PRESETS[btn.dataset.wbPreset];
      if (preset) {
        state.wb = preset.k;
        $('sl-wb').value = state.wb === 0 ? 5500 : state.wb;
        updateQuickLabels();
        await applyManualControls();
        document.querySelectorAll('[data-wb-preset]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });

  $('btn-lock-controls').addEventListener('click', toggleLock);

  // Miniatura → vista previa
  $('last-thumb').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.lastThumbUrl) return;
    $('preview-img').src = state.lastThumbUrl;
    $('preview-name').textContent = e.target.dataset.name || '';
    showScreen('preview');
  });
  $('btn-close-preview').addEventListener('click', () => showScreen('cam'));

  // ── Ajustes ──
  $('set-format').addEventListener('change', (e) => { state.format = e.target.value; });
  $('set-width').addEventListener('input',  (e) => { state.width  = parseInt(e.target.value) || 1200; });
  $('set-height').addEventListener('input', (e) => { state.height = parseInt(e.target.value) || 1200; });
  $('set-quality').addEventListener('input', (e) => {
    state.quality = parseInt(e.target.value) / 100;
    $('quality-desc').textContent = e.target.value + '%';
  });

  toggleSetup('tog-autonumber', 'autoNumber');
  toggleSetup('tog-warn-exists', 'warnExists');
  toggleSetup('tog-grid', 'showGrid', () => {
    $('grid-overlay').classList.toggle('visible', state.showGrid);
  });
  toggleSetup('tog-front-cam', 'frontCam');
  toggleSetup('tog-white-bg', 'whiteBg');
  toggleSetup('tog-sharpen', 'sharpen');
  toggleSetup('tog-guided', 'guidedShot', () => {
    if (state.guidedShot) startGuidedAnalysis();
    else stopGuidedAnalysis();
  });

  // Input: sincronizar contador al cambiar código
  $('product-input').addEventListener('input', () => {
    const code  = $('product-input').value.trim();
    const count = state.savedFiles[code] || 0;
    $('photo-count').textContent  = state.photoCount;
    $('product-counter').textContent = count;
  });

  // Enter → disparar
  $('product-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); takePhoto(); }
  });

  // Teclas de volumen / espacio como disparador
  document.addEventListener('keydown', (e) => {
    if (e.key === 'VolumeDown' || e.key === 'VolumeUp' || e.key === ' ') {
      if (screens.cam.classList.contains('active') && document.activeElement !== $('product-input')) {
        e.preventDefault();
        takePhoto();
      }
    }
  });
}

function toggleSetup(id, stateKey, extra) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('click', () => {
    state[stateKey] = !state[stateKey];
    setToggle(id, state[stateKey]);
    if (extra) extra();
  });
}

// ── SERVICE WORKER ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── ARRANQUE ───────────────────────────────────────────────────
init();
