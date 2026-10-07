// Appunti Lezione per telefono e tablet. Qui la lezione si raccoglie: registrazione audio, slide, appunti,
// disegni, foto e momenti ⭐. La trascrizione e il documento si fanno sul Mac, dopo aver inviato il file .lezione.
import {
  APP_VERSION, esc, fmtTime, fmtDur, fmtSize, fileName, lsGet, lsSet, loadImg,
  openDB, getLesson, allLessons, putLesson, getFile, putFile, normalizeLesson, newLessonObj, deleteLessonData,
  logSlide, AudioRecorder, repairAudio, recordedMs, addPhoto, photoBlob, deletePhoto,
  exportLesson, readPackage, storePackage, claimSingleInstance,
} from '../shared.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.min.js';

const $ = (s) => document.querySelector(s);
const WIDE = matchMedia('(min-width: 760px) and (orientation: landscape)');
// solo per le prove automatiche: un suono sintetico al posto del microfono
const TEST_AUDIO = new URLSearchParams(location.search).has('test-audio');

// ---------- Stato ----------
let L = null;   // lezione aperta
let pdf = null; // slide (PDF.js)
let slide = 1;
const W = 1600; // risoluzione del livello disegni, uguale a quella dell'app per Mac
let H = 900;

let saveTimer = null;
const saveFailed = (e) => showWarn('⚠️ Salvataggio non riuscito (spazio esaurito?): ' + (e?.message || ''));
function save() {
  const lesson = L;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; putLesson(lesson).catch(saveFailed); }, 400);
}
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (L) await putLesson(L).catch(saveFailed);
}

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.fn(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 3500);
}
const showWarn = (msg) => { $('#warn').textContent = msg; $('#warn').hidden = !msg; };

function author() { return lsGet('author') || ''; }
function askName() {
  const name = prompt('Come ti chiami? Serve ai tuoi compagni per sapere di chi sono note e foto.', author());
  if (name != null) lsSet('author', name.trim());
  $('#nameBtn').textContent = '👤 ' + (author() || 'Il tuo nome');
}

const label = () => (pdf ? 'Slide' : 'Sezione');
const maxSlide = (forNav) => (pdf ? pdf.numPages : (L.sections || 1) + (forNav ? 1 : 0));

// ---------- Elenco delle lezioni ----------
async function showHome() {
  L = null; pdf = null;
  $('#lesson').hidden = true;
  $('#home').hidden = false;
  const list = (await allLessons()).sort((a, b) => b.createdAt - a.createdAt);
  $('#lessonList').innerHTML = list.length ? list.map((l) => {
    normalizeLesson(l);
    const notes = Object.values(l.notes).filter(Boolean).length, rec = recordedMs(l);
    const bits = [new Date(l.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })];
    if (rec) bits.push('🎙 ' + fmtDur(rec));
    if (l.pages) bits.push(`📄 ${l.pages} slide`);
    if (notes) bits.push(`✍️ ${notes}`);
    if (l.photos.length) bits.push(`📷 ${l.photos.length}`);
    if (l.markers.length) bits.push(`⭐ ${l.markers.length}`);
    return `<button class="lesson-card" data-id="${l.id}"><b>${esc(l.title || 'Senza titolo')}</b><span>${bits.join(' · ')}</span></button>`;
  }).join('') : '<div class="empty">Nessuna lezione ancora.<br>Tocca <b>＋ Nuova lezione</b> quando inizia.</div>';

  let info = `Appunti Lezione ${APP_VERSION}. Le lezioni restano su questo dispositivo: a fine lezione inviale al Mac.`;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota) info += ` Spazio usato ${fmtSize(usage)}, libero circa ${fmtSize(quota - usage)}.`;
    if (quota && quota - usage < 300e6) info += ' ⚠️ Poco spazio: invia e poi elimina le lezioni vecchie.';
  } catch {}
  $('#homeInfo').textContent = info;
}
$('#lessonList').onclick = (e) => { const id = e.target.closest('.lesson-card')?.dataset.id; if (id) openLesson(id); };
$('#newLesson').onclick = async () => {
  const l = newLessonObj({ author: author() });
  await putLesson(l);
  await openLesson(l.id);
};
$('#nameBtn').onclick = askName;
$('#importInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const pkg = await readPackage(file);
    const exists = await getLesson(pkg.lesson.id);
    const copy = !!exists && !confirm('Hai già questa lezione su questo dispositivo.\nOK = sostituiscila con il file · Annulla = tienile entrambe');
    const lesson = await storePackage(pkg, { copy });
    await openLesson(lesson.id);
    toast('✓ Lezione importata');
  } catch (err) { alert(err.message); }
};

// ---------- Lezione ----------
async function openLesson(id) {
  L = normalizeLesson(await getLesson(id));
  if (await repairAudio(L)) await putLesson(L); // recupera l'audio di una registrazione interrotta di colpo
  $('#title').value = L.title;
  pdf = null;
  const buf = await getFile('pdf:' + id);
  if (buf) {
    try { pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise; }
    catch { toast('Non riesco ad aprire le slide salvate'); }
  }
  $('#home').hidden = true;
  $('#lesson').hidden = false;
  showWarn('');
  updateRecUI();
  await goTo(Math.min(L.slide || 1, maxSlide()));
}
$('#back').onclick = async () => {
  if (recording && !confirm('Stai registrando. Fermare la registrazione e tornare all\'elenco?')) return;
  if (recording) await stopRec();
  flushDrawing();
  await flushSave();
  showHome();
};
$('#title').oninput = (e) => { L.title = e.target.value; save(); };
$('#title').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };

async function goTo(n) {
  flushDrawing();
  n = Math.max(1, Math.min(n, maxSlide(true)));
  slide = n;
  L.slide = n;
  if (!pdf) L.sections = Math.max(L.sections || 1, n);
  logSlide(L, n);
  undoStack = [];
  save();
  $('#pageLabel').textContent = pdf ? `${n} / ${pdf.numPages}` : `Sez. ${n}`;
  $('#notesLabel').textContent = `✍️ Appunti — ${label()} ${n}`;
  $('#notes').innerHTML = L.notes[n] || '';
  renderPhotos();
  renderProf();
  renderSlide().catch(console.error); // senza attendere: con la scheda in secondo piano il disegno resta in sospeso
}
$('#prev').onclick = () => goTo(slide - 1);
$('#next').onclick = () => goTo(slide + 1);

// ---------- Slide ----------
const box = $('#canvasBox'), sc = $('#slideCanvas'), dc = $('#drawCanvas'), st = $('#strokeCanvas');
let renderSeq = 0, renderTask = null;

async function renderSlide() {
  const tok = ++renderSeq;
  if (renderTask) { renderTask.cancel(); renderTask = null; }
  let page = null, aspect = 9 / 16;
  if (pdf) {
    page = await pdf.getPage(slide);
    if (tok !== renderSeq) return;
    const v = page.getViewport({ scale: 1 });
    aspect = v.height / v.width;
  }
  H = Math.round(W * aspect);

  // in verticale la slide occupa al massimo il 40% dello schermo, il resto è per gli appunti
  const stage = $('#stage');
  const maxW = stage.clientWidth - 16, maxH = WIDE.matches ? stage.clientHeight - 16 : Math.round(window.innerHeight * 0.4);
  let w = maxW, h = w * aspect;
  if (h > maxH) { h = maxH; w = h / aspect; }
  box.style.width = Math.floor(w) + 'px';
  box.style.height = Math.floor(h) + 'px';

  const saved = L.drawings[slide];
  const img = saved ? await loadImg(saved).catch(() => null) : null;
  if (tok !== renderSeq) return;
  for (const c of [dc, st]) { c.width = W; c.height = H; }
  if (img) dc.getContext('2d').drawImage(img, 0, 0, W, H);

  const ctx = sc.getContext('2d');
  if (page) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = page.getViewport({ scale: (w * dpr) / page.getViewport({ scale: 1 }).width });
    sc.width = vp.width; sc.height = vp.height;
    renderTask = page.render({ canvasContext: ctx, viewport: vp });
    try { await renderTask.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); }
    if (tok === renderSeq) renderTask = null;
  } else {
    sc.width = W; sc.height = H;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#b8bcc6'; ctx.textAlign = 'center';
    ctx.font = '600 64px system-ui'; ctx.fillText(`Sezione ${slide}`, W / 2, H / 2 - 20);
    ctx.font = '40px system-ui'; ctx.fillText('Carica le slide dal menu ⋯ oppure usa questo foglio', W / 2, H / 2 + 50);
  }
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (L) { flushDrawing(); renderSlide(); } }, 200); });

$('#pdfInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  closeSheet();
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    await putFile('pdf:' + L.id, buf);
    pdf = doc;
    L.pages = doc.numPages;
    if (!L.title || L.title.startsWith('Lezione del ')) { L.title = file.name.replace(/\.pdf$/i, ''); $('#title').value = L.title; }
    await goTo(1);
    toast(`📄 ${doc.numPages} slide caricate`);
  } catch { alert('Non riesco ad aprire questo file: serve un PDF (da PowerPoint o Keynote: Esporta → PDF).'); }
};

// ---------- Disegno e sfoglio ----------
// Con ✋ il dito sfoglia le slide; con Apple Pencil o uno stilo si scrive comunque.
// Il tratto in corso sta su un livello suo (serve all'evidenziatore, che è trasparente) e si fonde alla fine.
let tool = 'none', stroke = null, swipe = null, undoStack = [], drawTimer = null;
document.querySelectorAll('[data-tool]').forEach((b) => b.onclick = () => {
  tool = b.dataset.tool;
  document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
});
const pt = (e) => { const r = box.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };

box.addEventListener('pointerdown', (e) => {
  const t = tool === 'none' && e.pointerType === 'pen' ? 'pen' : tool;
  if (t === 'none') { swipe = { x: e.clientX, y: e.clientY, id: e.pointerId }; return; }
  if (stroke) return; // un tratto alla volta: il palmo appoggiato non disegna
  e.preventDefault();
  try { box.setPointerCapture(e.pointerId); } catch {} // alcuni browser rifiutano la cattura per certi puntatori: il tratto funziona lo stesso
  undoStack.push(dc.getContext('2d').getImageData(0, 0, W, H));
  if (undoStack.length > 8) undoStack.shift();
  const ctx = (t === 'hl' ? st : dc).getContext('2d');
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = t === 'eraser' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = $('#color').value;
  ctx.lineWidth = t === 'eraser' ? 48 : t === 'hl' ? 32 : 6;
  stroke = { id: e.pointerId, tool: t, ctx, last: pt(e), slide };
  drawTo(e);
});
function drawTo(e) {
  const [x, y] = pt(e), [lx, ly] = stroke.last;
  stroke.ctx.beginPath();
  stroke.ctx.moveTo(lx, ly);
  stroke.ctx.lineTo(x === lx && y === ly ? x + 0.1 : x, y);
  stroke.ctx.stroke();
  stroke.last = [x, y];
}
box.addEventListener('pointermove', (e) => {
  if (!stroke || e.pointerId !== stroke.id) return;
  const fine = e.getCoalescedEvents?.(); // tutti i punti intermedi tra un fotogramma e l'altro: tratto più morbido
  for (const ev of fine?.length ? fine : [e]) drawTo(ev);
});
function endStroke(e) {
  if (swipe && e.pointerId === swipe.id) {
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (e.type === 'pointerup' && Math.abs(dx) > 50 && Math.abs(dy) < 60) goTo(slide + (dx < 0 ? 1 : -1));
    return;
  }
  if (!stroke || e.pointerId !== stroke.id) return;
  if (stroke.tool === 'hl') { // fonde l'evidenziatore nel livello disegni con la sua trasparenza
    const ctx = dc.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.35;
    ctx.drawImage(st, 0, 0);
    ctx.globalAlpha = 1;
    st.getContext('2d').clearRect(0, 0, W, H);
  }
  stroke.ctx.globalCompositeOperation = 'source-over';
  stroke = null;
  drawTimer ||= setTimeout(flushDrawing, 800); // la codifica dell'immagine è lenta: una volta sola dopo una raffica di tratti
}
box.addEventListener('pointerup', endStroke);
box.addEventListener('pointercancel', endStroke);
function flushDrawing() {
  if (!drawTimer || !L) return;
  clearTimeout(drawTimer);
  drawTimer = null;
  L.drawings[slide] = dc.toDataURL('image/png');
  save();
}
$('#undo').onclick = () => {
  const snap = undoStack.pop();
  if (!snap) return;
  dc.getContext('2d').putImageData(snap, 0, 0);
  drawTimer ||= setTimeout(flushDrawing, 300);
};

// ---------- Appunti ----------
$('#notes').addEventListener('input', () => {
  const el = $('#notes');
  if (el.textContent.trim()) L.notes[slide] = el.innerHTML;
  else { delete L.notes[slide]; el.innerHTML = ''; }
  save();
});

// se la lezione è già stata trascritta (importata dal Mac), mostra le parole del professore su questa slide
function renderProf() {
  const segs = L.segments.filter((s) => s.slide === slide);
  $('#profBox').hidden = !segs.length;
  $('#profText').innerHTML = segs.map((s) => `<p${s.star ? ' class="star"' : ''}>${s.star ? '⭐ ' : ''}${esc(s.text)}</p>`).join('');
}

// ---------- Registrazione ----------
// Su telefono il sistema può fermare il microfono in qualsiasi momento (schermo bloccato, telefonata, altra app).
// Un controllo ogni 2 secondi se ne accorge, avvisa e fa ripartire la registrazione appena l'app torna visibile.
let recording = false, recorder = null, stream = null, wakeLock = null, ticker = null;
let meterCtx = null, analyser = null, meterBuf = null, gapStart = 0, restarting = false, lastSave = 0, quietSince = 0;

async function getMic() {
  if (TEST_AUDIO) {
    const ac = new AudioContext(), dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(), gain = ac.createGain();
    gain.gain.value = 0.2;
    osc.connect(gain).connect(dest);
    osc.start();
    return dest.stream;
  }
  // niente filtri del telefono: sono pensati per le chiamate e peggiorano le voci lontane
  return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
}

function beginSegment() {
  recorder = new AudioRecorder(L, stream);
  try {
    analyser = meterCtx.createAnalyser();
    analyser.fftSize = 1024;
    meterBuf = new Float32Array(analyser.fftSize);
    meterCtx.createMediaStreamSource(stream).connect(analyser);
    meterCtx.resume().catch(() => {});
  } catch { analyser = null; }
  quietSince = 0;
  save();
}

async function startRec() {
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    return alert('Questo browser non può registrare. Usa Safari su iPhone e iPad, Chrome su Android, aggiornati.');
  }
  meterCtx ||= new (window.AudioContext || window.webkitAudioContext)(); // va creato durante il tocco
  try { stream = await getMic(); }
  catch (e) {
    return alert(e.name === 'NotAllowedError'
      ? 'Microfono non consentito. Vai nelle impostazioni del browser per questo sito e consenti il microfono.'
      : 'Non riesco ad accedere al microfono: ' + e.message);
  }
  recording = true;
  gapStart = 0;
  beginSegment();
  requestWake();
  ticker = setInterval(tick, 500);
  updateRecUI();
  toast('● Registrazione avviata: tieni l\'app aperta e lo schermo acceso');
}

async function stopSegment() {
  const r = recorder;
  recorder = null;
  analyser = null;
  if (r) await r.stop().catch(() => {});
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}
async function stopRec() {
  recording = false;
  clearInterval(ticker);
  await stopSegment();
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  showWarn('');
  updateRecUI();
  await flushSave();
}
$('#recBtn').onclick = () => (recording ? stopRec() : startRec());

async function requestWake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

function updateRecUI() {
  const total = L ? recordedMs(L) : 0;
  $('#recBtn').classList.toggle('on', recording);
  $('#recBar').classList.toggle('on', recording);
  $('#recBtn').textContent = recording ? '⏸ Pausa' : total ? '● Riprendi' : '● Registra';
  $('#recTime').textContent = fmtDur(total);
  if (!recording) $('#level').style.width = '0';
  if (L) $('#recInfo').textContent = [L.markers.length && `⭐ ${L.markers.length}`, L.photos.length && `📷 ${L.photos.length}`].filter(Boolean).join('  ');
}

function tick() {
  if (!recording) return;
  if (recorder) recorder.entry.end = Math.max(recorder.entry.end, recorder.lastData);
  const now = Date.now(), live = recorder && !gapStart ? now - recorder.lastData : 0;
  $('#recTime').textContent = fmtDur(recordedMs(L) + Math.min(live, 5000));
  if (!$('#dim').hidden) $('#dimTime').textContent = '● ' + $('#recTime').textContent;

  if (analyser) {
    analyser.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (const v of meterBuf) sum += v * v;
    const rms = Math.sqrt(sum / meterBuf.length);
    $('#level').style.width = Math.min(100, rms * 2500) + '%';
    quietSince = rms > 0.0005 ? 0 : (quietSince || now);
  }
  if (now - lastSave > 30000) { lastSave = now; save(); } // così la lezione salvata conosce i pezzi di audio già scritti

  const track = stream?.getAudioTracks()[0];
  const silent = quietSince && now - quietSince > 15000 && !TEST_AUDIO;
  const ok = recorder?.healthy && track?.readyState === 'live' && !track.muted;
  if (ok) {
    if (gapStart) { toast(`✓ Registrazione ripresa (interrotta per ${fmtDur(now - gapStart)})`); gapStart = 0; }
    showWarn(silent ? '⚠️ Il microfono non sente nulla da un po\': controlla che non sia coperto.' : '');
    return;
  }
  if (!gapStart) gapStart = recorder?.lastData || now;
  showWarn('⚠️ Registrazione interrotta dal sistema. Tieni l\'app aperta in primo piano: riparte da sola.');
  if (!restarting && document.visibilityState === 'visible') restartRec();
}

async function restartRec() {
  restarting = true;
  try {
    await stopSegment();
    stream = await getMic();
    beginSegment();
  } catch {}
  setTimeout(() => { restarting = false; }, 6000); // non riprovare a raffica se il microfono resta occupato
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (recording) { requestWake(); tick(); } }
  else if (L) { flushDrawing(); putLesson(L).catch(() => {}); }
});
window.addEventListener('pagehide', () => { if (L) { flushDrawing(); putLesson(L).catch(() => {}); } });

// ---------- Momenti importanti ----------
$('#starBtn').onclick = () => {
  const m = { t: Date.now(), slide, text: '', author: author() };
  L.markers.push(m);
  save();
  updateRecUI();
  navigator.vibrate?.(30);
  toast(`⭐ Segnato alle ${fmtTime(m.t).slice(0, 5)}${recording ? '' : ' (non stai registrando)'}`, {
    label: '＋ nota',
    fn: () => { const text = prompt('Cosa c\'è di importante in questo momento?'); if (text?.trim()) { m.text = text.trim(); save(); } },
  });
};

// ---------- Foto ----------
let photoUrls = [], viewed = null;
async function renderPhotos() {
  const lesson = L, n = slide;
  const list = lesson.photos.filter((p) => p.slide === n || !p.slide);
  const blobs = await Promise.all(list.map(photoBlob));
  if (lesson !== L || n !== slide) return;
  photoUrls.forEach((u) => URL.revokeObjectURL(u));
  photoUrls = [];
  $('#photoStrip').innerHTML = list.map((p, i) => {
    if (!blobs[i]) return '';
    const url = URL.createObjectURL(blobs[i]);
    photoUrls.push(url);
    return `<button class="thumb" data-key="${esc(p.key)}"><img src="${url}" alt="${p.kind === 'mano' ? 'Appunti a mano' : 'Foto'}"></button>`;
  }).join('');
  $('#photoStrip').hidden = !$('#photoStrip').children.length;
}
async function addPhotos(files, kind) {
  let n = 0;
  for (const f of files) {
    try { await addPhoto(L, f, { slide, kind, author: author() }); n++; }
    catch (e) { toast(e.message); }
  }
  if (!n) return;
  save();
  updateRecUI();
  renderPhotos();
  toast(`${kind === 'mano' ? '✍️' : '📷'} ${n === 1 ? 'Foto aggiunta' : n + ' foto aggiunte'} a ${label()} ${slide}`);
}
$('#photoInput').onchange = (e) => { addPhotos([...e.target.files], 'lavagna'); e.target.value = ''; };
$('#handInput').onchange = (e) => { closeSheet(); addPhotos([...e.target.files], 'mano'); e.target.value = ''; };
$('#photoStrip').onclick = async (e) => {
  viewed = L.photos.find((p) => p.key === e.target.closest('.thumb')?.dataset.key);
  if (!viewed) return;
  URL.revokeObjectURL($('#viewerImg').src);
  $('#viewerImg').src = URL.createObjectURL(await photoBlob(viewed));
  $('#viewer').hidden = false;
};
$('#viewerClose').onclick = () => { $('#viewer').hidden = true; };
$('#viewerDelete').onclick = async () => {
  if (!confirm('Eliminare questa foto?')) return;
  await deletePhoto(L, viewed);
  save();
  $('#viewer').hidden = true;
  updateRecUI();
  renderPhotos();
};

// ---------- Menu, invio, eliminazione ----------
const closeSheet = () => { $('#sheet').hidden = true; };
$('#menuBtn').onclick = () => { $('#sheet').hidden = false; };
$('#sheetClose').onclick = closeSheet;
$('#sheet').onclick = (e) => { if (e.target.id === 'sheet') closeSheet(); };

let shareFile = null;
$('#shareBtn').onclick = async () => {
  closeSheet();
  if (recording && !confirm('Per inviare la lezione la registrazione va fermata. Fermarla adesso?')) return;
  if (recording) await stopRec();
  flushDrawing();
  if (!L.author) L.author = author();
  await flushSave();
  $('#shareBox').hidden = false;
  $('#shareGo').hidden = $('#shareSave').hidden = true;
  $('#shareInfo').textContent = 'Preparo il file…';
  try {
    const blob = await exportLesson(L, { onProgress: (f) => { $('#shareInfo').textContent = `Preparo il file… ${Math.round(f * 100)}%`; } });
    shareFile = new File([blob], fileName(L.title) + '.lezione', { type: 'application/zip' });
    const has = [recordedMs(L) && `${fmtDur(recordedMs(L))} di registrazione`, pdf && 'le slide', 'appunti e disegni',
      L.photos.length && `${L.photos.length} foto`, L.markers.length && `${L.markers.length} ${L.markers.length === 1 ? 'momento' : 'momenti'} ⭐`].filter(Boolean).join(', ');
    $('#shareInfo').textContent = `«${shareFile.name}» (${fmtSize(blob.size)}) contiene: ${has}.`;
    URL.revokeObjectURL($('#shareSave').href);
    $('#shareSave').href = URL.createObjectURL(blob);
    $('#shareSave').download = shareFile.name;
    $('#shareSave').hidden = false;
    $('#shareGo').hidden = !navigator.canShare?.({ files: [shareFile] });
  } catch (e) { $('#shareInfo').textContent = 'Non riesco a preparare il file: ' + e.message; }
};
// il tocco deve aprire subito il foglio di condivisione: per questo il file è già pronto
$('#shareGo').onclick = async () => {
  try { await navigator.share({ files: [shareFile], title: L.title }); toast('✓ Lezione inviata'); }
  catch (e) { if (e.name !== 'AbortError') toast('Condivisione non riuscita: usa «Salva il file»'); }
};
$('#shareClose').onclick = () => { $('#shareBox').hidden = true; };

$('#deleteBtn').onclick = async () => {
  if (!confirm(`Eliminare «${L.title}» da questo dispositivo, con registrazione, appunti e foto?\nSe non l'hai ancora inviata al Mac andrà persa.`)) return;
  closeSheet();
  if (recording) await stopRec();
  clearTimeout(saveTimer); saveTimer = null;
  clearTimeout(drawTimer); drawTimer = null;
  await deleteLessonData(L);
  showHome();
};

// ---------- Schermo scuro ----------
$('#dimBtn').onclick = () => {
  $('#dimTime').textContent = recording ? '● ' + $('#recTime').textContent : 'In pausa';
  $('#dim').hidden = false;
};
$('#dim').onclick = () => { $('#dim').hidden = true; };

// ---------- Avvio ----------
if (!(await claimSingleInstance())) {
  document.body.insertAdjacentHTML('beforeend', '<div id="blocked"><div><h2>Appunti Lezione è già aperta</h2><p>È aperta in un\'altra scheda o finestra di questo browser. Usa quella, oppure chiudila e ricarica questa pagina.</p></div></div>');
  throw new Error('app già aperta in un\'altra scheda');
}
await openDB();
navigator.storage?.persist?.().catch(() => {}); // chiede al browser di non cancellare mai da solo le lezioni
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
$('#nameBtn').textContent = '👤 ' + (author() || 'Il tuo nome');

// Installata sulla schermata Home l'app funziona senza rete e il sistema non ne cancella i dati.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (!standalone && !lsGet('tipSeen')) {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const tip = $('#installTip');
  tip.innerHTML = (ios
    ? '<b>Prima di usarla a lezione:</b> tocca <b>Condividi</b> (il quadrato con la freccia) → <b>Aggiungi alla schermata Home</b>, poi aprila da lì.'
    : '<b>Prima di usarla a lezione:</b> apri il menu del browser (⋮) → <b>Installa app</b> o <b>Aggiungi a schermata Home</b>, poi aprila da lì.')
    + ' Così funziona anche senza internet e le lezioni non vengono cancellate. <u>Ho capito</u>';
  tip.hidden = false;
  tip.onclick = () => { tip.hidden = true; lsSet('tipSeen', '1'); };
}
await showHome();
