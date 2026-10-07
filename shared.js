// Parti comuni all'app per Mac (app.js) e a quella per telefoni e tablet (mobile/mobile.js):
// archivio locale (IndexedDB), registrazione audio che sopravvive a una chiusura improvvisa,
// foto, e il file ".lezione" con cui una lezione passa da un dispositivo all'altro.
export const APP_VERSION = '3.0'; // deve coincidere con APP_VERSION in server.py

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtTime = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s % 60).padStart(2, '0');
};
export const fmtSize = (bytes) => (bytes > 1048576 ? (bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 1) + ' MB' : Math.ceil(bytes / 1024) + ' KB');
export const fileName = (s) => (s || 'lezione').replace(/[\\/:*?"<>|]+/g, '-').trim();
export const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
export const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// Due schede aperte sulla stessa app si sovrascriverebbero le lezioni a vicenda: la prima tiene un "lucchetto"
// finché resta aperta, le altre lo trovano occupato. Restituisce false se l'app è già aperta altrove.
export function claimSingleInstance() {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((res) => {
    navigator.locks.request('appunti-lezione', { ifAvailable: true }, (lock) => {
      res(!!lock);
      return lock ? new Promise(() => {}) : undefined; // mai risolta: il lucchetto dura quanto la scheda
    }).catch(() => res(true));
  });
}

// ---------- Archivio locale ----------
let dbPromise;
export function openDB() {
  dbPromise ||= new Promise((res, rej) => {
    const r = indexedDB.open('appunti-lezione', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('lessons', { keyPath: 'id' });
      r.result.createObjectStore('files');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise;
}
async function idb(store, mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Spazio esaurito o archivio non disponibile'));
  });
}
export const getLesson = (id) => idb('lessons', 'readonly', (s) => s.get(id));
export const allLessons = () => idb('lessons', 'readonly', (s) => s.getAll());
export const putLesson = (l) => idb('lessons', 'readwrite', (s) => s.put(l));
export const delLesson = (id) => idb('lessons', 'readwrite', (s) => s.delete(id));
export const getFile = (k) => idb('files', 'readonly', (s) => s.get(k));
export const putFile = (k, v) => idb('files', 'readwrite', (s) => s.put(v, k));
export const delFile = (k) => idb('files', 'readwrite', (s) => s.delete(k));
const fileKeys = (prefix) => idb('files', 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')));

// ---------- Lezione ----------
export function normalizeLesson(l) {
  l.segments ||= []; l.notes ||= {}; l.drawings ||= {}; l.audio ||= [];
  l.slideLog ||= [];  // [{t, slide}]: quando è stata aperta ogni slide, per collegare l'audio alle slide
  l.markers ||= [];   // [{t, slide, text}]: momenti segnati con ⭐
  l.photos ||= [];    // [{key, t, slide, kind, type, author, text}]: lavagna e appunti a mano (slide 0 = tutta la lezione)
  return l;
}
export function newLessonObj(extra = {}) {
  const d = new Date();
  return normalizeLesson({
    id: crypto.randomUUID(),
    title: 'Lezione del ' + d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }),
    createdAt: Date.now(), slide: 1, sections: 1, ...extra,
  });
}
export async function deleteLessonData(lesson) {
  await delFile('pdf:' + lesson.id);
  for (const k of await fileKeys(`audio:${lesson.id}:`)) await delFile(k);
  for (const k of await fileKeys(`photo:${lesson.id}:`)) await delFile(k);
  await delLesson(lesson.id);
}

export function logSlide(lesson, slide) {
  const log = lesson.slideLog;
  if (log.length && Date.now() - log.at(-1).t < 1500) log.pop(); // sfogliando di corsa conta solo la slide su cui ci si ferma
  if (log.at(-1)?.slide !== slide) log.push({ t: Date.now(), slide });
}
// Quando è stata aperta ogni slide. Per le lezioni registrate prima che esistesse slideLog si ricava
// dalle frasi già trascritte dal vivo, che ricordano su quale slide sono state dette.
export function timeline(lesson) {
  const firstLog = lesson.slideLog[0]?.t ?? Infinity;
  return [...lesson.segments.filter((s) => s.t < firstLog).map((s) => ({ t: s.t, slide: s.slide })), ...lesson.slideLog];
}
// La slide aperta all'istante t.
export function slideAt(lesson, t) {
  const log = timeline(lesson);
  let slide = log[0]?.slide ?? 1;
  for (const e of log) { if (e.t <= t) slide = e.slide; else break; }
  return slide;
}

// ---------- Registrazione audio ----------
// L'audio viene scritto nell'archivio un pezzo ogni 5 secondi: se il browser si chiude, la batteria finisce
// o il telefono blocca l'app, si perdono al massimo gli ultimi secondi. I pezzi messi in fila formano un file
// valido anche se troncato (verificato su Safari iOS, che produce MP4 frammentato, e su Chrome, WebM).
const TIMESLICE = 5000;
const partKey = (key, n) => `${key}:${String(n).padStart(6, '0')}`;

export class AudioRecorder {
  constructor(lesson, stream) {
    this.lesson = lesson;
    this.mr = new MediaRecorder(stream, { audioBitsPerSecond: 64000 });
    this.entry = { key: `audio:${lesson.id}:${Date.now()}`, start: Date.now(), end: Date.now(), mime: this.mr.mimeType, parts: 0 };
    this.writes = Promise.resolve();
    this.lastData = Date.now();
    this.error = null;
    this.mr.ondataavailable = (e) => {
      if (!e.data.size) return;
      const n = this.entry.parts++;
      this.entry.end = this.lastData = Date.now();
      lsSet('recEnd:' + this.entry.key, this.entry.end); // se l'app viene chiusa di colpo, resta l'ora dell'ultimo pezzo
      this.entry.mime ||= e.data.type;
      this.writes = this.writes.then(async () => putFile(partKey(this.entry.key, n), await e.data.arrayBuffer()))
        .catch((err) => { this.error = err; });
    };
    this.mr.onerror = (e) => { this.error = e.error || new Error('errore del registratore'); };
    lesson.audio.push(this.entry);
    this.mr.start(TIMESLICE);
  }
  // false se il sistema ha fermato la registrazione o non arrivano più dati (telefono bloccato, altra app in primo piano…)
  get healthy() { return !this.error && this.mr.state === 'recording' && Date.now() - this.lastData < TIMESLICE * 3; }
  async stop() {
    if (this.mr.state !== 'inactive') {
      await new Promise((res) => { this.mr.addEventListener('stop', res, { once: true }); try { this.mr.stop(); } catch { res(); } });
    }
    await this.writes;
    try { localStorage.removeItem('recEnd:' + this.entry.key); } catch {}
    if (!this.entry.parts) this.lesson.audio = this.lesson.audio.filter((a) => a !== this.entry);
    return this.entry;
  }
}

// Dopo una chiusura improvvisa la lezione salvata può non sapere quanti pezzi di audio esistono: li riconta.
export async function repairAudio(lesson) {
  let changed = false;
  for (const a of lesson.audio) {
    if (a.parts == null) continue; // vecchio formato: un unico file
    const n = (await fileKeys(a.key + ':')).length;
    const seen = +lsGet('recEnd:' + a.key) || 0; // ora dell'ultimo pezzo scritto prima della chiusura
    if (n !== a.parts || seen > (a.end || 0)) { a.parts = n; a.end = seen || Math.max(a.end || 0, a.start + n * TIMESLICE); changed = true; }
    if (seen) try { localStorage.removeItem('recEnd:' + a.key); } catch {}
  }
  const kept = lesson.audio.filter((a) => a.parts == null || a.parts > 0);
  if (kept.length !== lesson.audio.length) { lesson.audio = kept; changed = true; }
  return changed;
}
async function audioParts(a) {
  if (a.parts == null) { const b = await getFile(a.key); return b ? [b] : []; }
  const bufs = [];
  for (let i = 0; i < a.parts; i++) { const b = await getFile(partKey(a.key, i)); if (b) bufs.push(b); }
  return bufs;
}
export async function audioBlob(a) {
  const parts = await audioParts(a);
  return new Blob(parts, { type: a.mime || parts[0]?.type || 'audio/webm' });
}
export const audioExt = (type = '') => (type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm');
export const recordedMs = (lesson) => lesson.audio.reduce((sum, a) => sum + Math.max(0, (a.end || a.start) - a.start), 0);

// ---------- Foto (lavagna, appunti a mano) ----------
async function shrink(blob, max = 2200) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}
export async function addPhoto(lesson, blob, { slide = 0, kind = 'lavagna', author = '', t = Date.now() } = {}) {
  let small;
  try { small = await shrink(blob); } catch { throw new Error('Formato immagine non supportato (usa JPG o PNG)'); }
  const key = `photo:${lesson.id}:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await putFile(key, await small.arrayBuffer());
  const photo = { key, t, slide, kind, type: small.type, author, text: '' };
  lesson.photos.push(photo);
  return photo;
}
export async function photoBlob(p) {
  const data = await getFile(p.key);
  return data ? new Blob([data], { type: p.type || 'image/jpeg' }) : null;
}
export async function deletePhoto(lesson, p) {
  await delFile(p.key);
  lesson.photos = lesson.photos.filter((x) => x !== p);
}

// ---------- File .lezione ----------
// È uno zip non compresso: lezione.json (testi, disegni, tempi) + slide.pdf + audio/ + foto/.
// light = senza PDF e senza audio: pochi MB, usato per le copie di sicurezza automatiche.
export async function exportLesson(lesson, { light = false, onProgress = () => {} } = {}) {
  const { Zip, ZipPassThrough, strToU8 } = globalThis.fflate;
  const chunks = [];
  let ok, fail;
  const finished = new Promise((res, rej) => { ok = res; fail = rej; });
  const zip = new Zip((err, chunk, final) => { if (err) return fail(err); chunks.push(chunk); if (final) ok(); });
  const add = (path) => { const f = new ZipPassThrough(path); zip.add(f); return f; };

  const copy = structuredClone(lesson);
  const files = [];
  const pdf = light ? null : await getFile('pdf:' + lesson.id);
  if (pdf) files.push({ path: 'slide.pdf', role: 'pdf', key: 'pdf:' + lesson.id, type: 'application/pdf' });
  copy.audio = light ? [] : copy.audio.map((a, i) => {
    files.push({ path: `audio/${i}.${audioExt(a.mime)}`, role: 'audio', key: a.key, type: a.mime || 'audio/webm' });
    return { key: a.key, start: a.start, end: a.end, mime: a.mime };
  });
  copy.photos.forEach((p, i) => files.push({ path: `foto/${i}.jpg`, role: 'photo', key: p.key, type: p.type || 'image/jpeg' }));

  const meta = { app: 'appunti-lezione', format: 1, version: APP_VERSION, exportedAt: Date.now(), light, lesson: copy, files };
  add('lezione.json').push(strToU8(JSON.stringify(meta)), true);
  let done = 0;
  for (const f of files) {
    const entry = add(f.path);
    if (f.role === 'audio') {
      for (const part of await audioParts(lesson.audio.find((a) => a.key === f.key))) {
        entry.push(new Uint8Array(part instanceof Blob ? await part.arrayBuffer() : part), false);
      }
      entry.push(new Uint8Array(0), true);
    } else {
      const data = await getFile(f.key);
      entry.push(data ? new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data) : new Uint8Array(0), true);
    }
    onProgress(++done / files.length);
  }
  zip.end();
  await finished;
  return new Blob(chunks, { type: 'application/zip' });
}

export async function readPackage(file) {
  const { unzipSync, strFromU8 } = globalThis.fflate;
  let entries, meta;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    meta = JSON.parse(strFromU8(entries['lezione.json']));
  } catch { throw new Error('Questo file non è una lezione di Appunti Lezione'); }
  if (meta.app !== 'appunti-lezione') throw new Error('Questo file non è una lezione di Appunti Lezione');
  return {
    lesson: normalizeLesson(meta.lesson),
    files: meta.files.filter((f) => entries[f.path]?.length).map((f) => ({ ...f, data: entries[f.path] })),
  };
}
const ownBuffer = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer);

// Scrive nell'archivio i file di un pacchetto con le chiavi della lezione `id` e restituisce quelli presenti.
async function storeFiles(pkg, id, roles) {
  const stored = new Map(); // chiave originale -> chiave nuova
  for (const f of pkg.files) {
    if (!roles.includes(f.role)) continue;
    const key = f.key.replace(pkg.lesson.id, id);
    await putFile(f.role === 'audio' ? partKey(key, 0) : key, ownBuffer(f.data));
    stored.set(f.key, key);
  }
  return stored;
}

// Importa il pacchetto come lezione a sé. copy = true le dà un nuovo identificativo (per tenerle entrambe);
// altrimenti sostituisce la lezione con lo stesso identificativo, se c'è. Un pacchetto "light" (copia di
// sicurezza senza PDF e audio) non cancella il PDF e l'audio già presenti.
export async function storePackage(pkg, { copy = false } = {}) {
  const lesson = pkg.lesson;
  const id = copy ? crypto.randomUUID() : lesson.id;
  const old = copy ? null : await getLesson(id);
  const has = (role) => pkg.files.some((f) => f.role === role);
  if (old) {
    if (has('pdf')) await delFile('pdf:' + id);
    if (has('audio')) for (const k of await fileKeys(`audio:${id}:`)) await delFile(k);
    for (const k of await fileKeys(`photo:${id}:`)) await delFile(k);
  }
  const stored = await storeFiles(pkg, id, ['pdf', 'audio', 'photo']);
  lesson.audio = old && !has('audio') ? normalizeLesson(old).audio
    : lesson.audio.filter((a) => stored.has(a.key)).map((a) => ({ ...a, key: stored.get(a.key), parts: 1 }));
  lesson.photos = lesson.photos.filter((p) => stored.has(p.key)).map((p) => ({ ...p, key: stored.get(p.key) }));
  lesson.id = id;
  if (copy) lesson.title += ' (copia)';
  await putLesson(lesson);
  return lesson;
}

// Unisce alla lezione `target` quello che ha raccolto un'altra persona: note, disegni, foto, momenti ⭐,
// e, se mancano, slide, registrazione e trascrizione. Restituisce l'elenco di ciò che è stato aggiunto.
export async function mergePackage(target, pkg) {
  const src = pkg.lesson, who = src.author || 'un compagno', added = [];
  const pdfFile = pkg.files.find((f) => f.role === 'pdf');
  if (pdfFile && !(await getFile('pdf:' + target.id))) {
    await putFile('pdf:' + target.id, ownBuffer(pdfFile.data));
    added.push('le slide');
  }

  const noteSlides = Object.keys(src.notes).filter((n) => src.notes[n]);
  for (const n of noteSlides) {
    target.notes[n] = (target.notes[n] || '') + `<p><b>— Note di ${esc(who)} —</b></p>` + src.notes[n];
  }
  if (noteSlides.length) added.push(`note su ${noteSlides.length} slide`);

  let drawn = 0;
  for (const n of Object.keys(src.drawings)) {
    if (!target.drawings[n]) target.drawings[n] = src.drawings[n];
    else { // sovrappone i due disegni
      const [a, b] = await Promise.all([loadImg(target.drawings[n]), loadImg(src.drawings[n])]);
      const c = document.createElement('canvas');
      c.width = a.width; c.height = a.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(a, 0, 0); ctx.drawImage(b, 0, 0, c.width, c.height);
      target.drawings[n] = c.toDataURL('image/png');
    }
    drawn++;
  }
  if (drawn) added.push(`disegni su ${drawn} slide`);

  if (src.markers.length) {
    target.markers = [...target.markers, ...src.markers.map((m) => ({ ...m, author: m.author || who }))].sort((a, b) => a.t - b.t);
    added.push(`${src.markers.length} momenti ⭐`);
  }

  const photoKeys = await storeFiles(pkg, target.id, ['photo']);
  const photos = src.photos.filter((p) => photoKeys.has(p.key)).map((p) => ({ ...p, key: photoKeys.get(p.key), author: p.author || who }));
  if (photos.length) { target.photos.push(...photos); added.push(`${photos.length} foto`); }

  if (!target.audio.length && src.audio.length) {
    const audioKeys = await storeFiles(pkg, target.id, ['audio']);
    target.audio = src.audio.filter((a) => audioKeys.has(a.key)).map((a) => ({ ...a, key: audioKeys.get(a.key), parts: 1 }));
    if (target.audio.length) {
      added.push('la registrazione audio');
      if (!target.segments.length) target.slideLog = src.slideLog; // i tempi delle slide devono essere quelli di chi ha registrato
    }
  }
  if (!target.segments.length && src.segments.length) {
    target.segments = src.segments;
    added.push('la trascrizione');
  }
  if (!target.title || target.title.startsWith('Lezione del ')) target.title = src.title;
  target.sections = Math.max(target.sections || 1, src.sections || 1);
  return added;
}
