(function () {
  if (window.__muLoaded) return;
  window.__muLoaded = true;

  const MAX_FILES_PER_REQUEST = 40;
  const MAX_BYTES_PER_REQUEST = 48 * 1024 * 1024;
  const ARCHIVE_BYTES_LIMIT = 300 * 1024 * 1024;
  const PARALLEL_REQUESTS = 3;

  const icons = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V8"/><path d="M6 14l6-6 6 6"/></svg>',
  };

  function el(tag, props, kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const key in props) {
        const value = props[key];
        if (key === 'class') node.className = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'text') node.textContent = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value);
      }
    }
    if (kids) for (const kid of kids) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return node;
  }

  function formatBytes(n) {
    if (n < 1024) return Math.round(n) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
  }

  function sumBytes(items) {
    return items.reduce(function (total, item) { return total + item.file.size; }, 0);
  }

  function joinPath(base, rel) {
    const parts = (base + '/' + rel).split('/').filter(Boolean);
    return '/' + parts.join('/');
  }

  function parentOf(path) {
    const cut = path.lastIndexOf('/');
    return cut <= 0 ? '/' : path.slice(0, cut);
  }

  function currentServer() {
    const match = location.pathname.match(/\/server\/([^/]+)/);
    return match ? match[1] : null;
  }

  function currentDir() {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    return hash && hash.charAt(0) === '/' ? hash : '/';
  }

  function onFilesPage() {
    return /\/server\/[^/]+\/files/.test(location.pathname);
  }

  const api = {
    async uploadUrl(server) {
      const res = await fetch('/api/client/servers/' + server + '/files/upload', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) throw new Error('Failed to request an upload url (' + res.status + ')');
      const data = await res.json();
      return data.attributes.url;
    },
    async decompress(server, root, file) {
      // Wings may need a moment before an just-uploaded archive is visible, so retry a few times.
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await sleep(700);
        try {
          await postJson('/api/client/servers/' + server + '/files/decompress', { root: root, file: file });
          return;
        } catch (err) {
          lastErr = err;
          if (err.status && err.status !== 404 && err.status !== 425) break;
        }
      }
      throw lastErr || new Error('Decompress failed');
    },
    async deleteFiles(server, root, files) {
      await postJson('/api/client/servers/' + server + '/files/delete', { root: root, files: files });
    },
  };

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function xsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function postJson(url, body) {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    const token = xsrfToken();
    if (token) headers['X-XSRF-TOKEN'] = token;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (err) { void err; }
      const error = new Error('POST ' + url + ' -> ' + res.status + (detail ? ' ' + detail : ''));
      error.status = res.status;
      console.error('[multiupload]', error.message);
      throw error;
    }
  }

  // ---- collecting dropped/picked files ----

  function readEntries(reader) {
    return new Promise(function (resolve, reject) {
      reader.readEntries(resolve, reject);
    });
  }

  async function walk(entry, prefix, bucket) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isFile) {
      const file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
      bucket.files.push({ file: file, path: path });
    } else if (entry.isDirectory) {
      bucket.dirs.add(path);
      const reader = entry.createReader();
      let chunk;
      do {
        chunk = await readEntries(reader);
        for (const child of chunk) await walk(child, path, bucket);
      } while (chunk.length);
    }
  }

  async function collectDropped(items) {
    const bucket = { files: [], dirs: new Set() };
    const roots = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) roots.push(entry);
    }
    for (const entry of roots) await walk(entry, '', bucket);
    return bucket;
  }

  function collectPicked(fileList) {
    const bucket = { files: [], dirs: new Set() };
    for (const file of fileList) {
      const rel = file.webkitRelativePath || file.name;
      bucket.files.push({ file: file, path: rel });
      const segments = rel.split('/').slice(0, -1);
      let acc = '';
      for (const seg of segments) {
        acc = acc ? acc + '/' + seg : seg;
        bucket.dirs.add(acc);
      }
    }
    return bucket;
  }

  function collectTransfer(dataTransfer) {
    if (dataTransfer.items && dataTransfer.items.length) return collectDropped(dataTransfer.items);
    if (dataTransfer.files && dataTransfer.files.length) return Promise.resolve(collectPicked(dataTransfer.files));
    return Promise.resolve({ files: [], dirs: new Set() });
  }

  // ---- zero-dependency tar writer, gzipped through the native CompressionStream ----

  const TAR_ENCODER = new TextEncoder();

  function octalField(buf, offset, value, len) {
    // (len - 1) octal digits, zero-padded, followed by a NUL byte.
    let str = Math.floor(value).toString(8);
    while (str.length < len - 1) str = '0' + str;
    for (let i = 0; i < len - 1; i++) buf[offset + i] = str.charCodeAt(i);
    buf[offset + len - 1] = 0;
  }

  function strField(buf, offset, str, maxLen) {
    const bytes = TAR_ENCODER.encode(str);
    const n = Math.min(bytes.length, maxLen);
    for (let i = 0; i < n; i++) buf[offset + i] = bytes[i];
  }

  // A single 512-byte ustar header block.
  function tarBlock(name, size, mtime, mode, typeflag) {
    const buf = new Uint8Array(512);
    strField(buf, 0, name, 100);
    octalField(buf, 100, mode, 8);
    octalField(buf, 108, 0, 8);            // uid
    octalField(buf, 116, 0, 8);            // gid
    octalField(buf, 124, size, 12);
    octalField(buf, 136, mtime, 12);
    for (let i = 148; i < 156; i++) buf[i] = 0x20; // checksum placeholder = spaces
    buf[156] = typeflag.charCodeAt(0);
    strField(buf, 257, 'ustar', 6);        // magic "ustar\0"
    buf[263] = 0x30; buf[264] = 0x30;      // version "00"
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += buf[i];
    octalField(buf, 148, sum, 7);          // 6 octal digits + NUL
    buf[155] = 0x20;                       // trailing space
    return buf;
  }

  // Header blocks for one file, using a GNU long-name block when the path exceeds 100 bytes.
  function tarHeaders(path, size, mtime) {
    const nameBytes = TAR_ENCODER.encode(path);
    const blocks = [];
    if (nameBytes.length > 100) {
      const data = new Uint8Array(nameBytes.length + 1);
      data.set(nameBytes);
      blocks.push(tarBlock('././@LongLink', data.length, 0, 0, 'L'));
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      blocks.push(padded);
    }
    blocks.push(tarBlock(path, size, mtime, 0o644, '0'));
    return blocks;
  }

  // Stream the tar directly into a gzip stream so only one file sits in memory at a time.
  async function buildTarGz(items) {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    const out = [];
    const pump = (async function () {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        out.push(step.value);
      }
    })();

    for (const item of items) {
      const raw = new Uint8Array(await item.file.arrayBuffer());
      const mtime = Math.floor((item.file.lastModified || Date.now()) / 1000);
      for (const block of tarHeaders(item.path, raw.length, mtime)) await writer.write(block);
      await writer.write(raw);
      const pad = raw.length % 512;
      if (pad) await writer.write(new Uint8Array(512 - pad));
    }
    await writer.write(new Uint8Array(1024)); // two zero blocks mark the end of the archive
    await writer.close();
    await pump;

    return new Blob(out, { type: 'application/gzip' });
  }

  function planArchives(files) {
    const archives = [];
    let chunk = [];
    let bytes = 0;
    for (const item of files) {
      if (chunk.length && bytes + item.file.size > ARCHIVE_BYTES_LIMIT) {
        archives.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(item);
      bytes += item.file.size;
    }
    if (chunk.length) archives.push(chunk);
    return archives;
  }

  function archiveName(i) {
    return 'mu-upload-' + Date.now().toString(36) + '-' + i + '.tar.gz';
  }

  // ---- upload plumbing ----

  function planBatches(base, files) {
    const groups = new Map();
    for (const item of files) {
      const dir = parentOf(joinPath(base, item.path));
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(item);
    }
    const batches = [];
    for (const [dir, items] of groups) {
      let chunk = [];
      let bytes = 0;
      for (const item of items) {
        if (chunk.length && (chunk.length >= MAX_FILES_PER_REQUEST || bytes + item.file.size > MAX_BYTES_PER_REQUEST)) {
          batches.push({ dir: dir, items: chunk });
          chunk = [];
          bytes = 0;
        }
        chunk.push(item);
        bytes += item.file.size;
      }
      if (chunk.length) batches.push({ dir: dir, items: chunk });
    }
    return batches;
  }

  function createController() {
    const controller = {
      cancelled: false,
      active: new Set(),
      cancel: function () {
        controller.cancelled = true;
        controller.active.forEach(function (xhr) { try { xhr.abort(); } catch (err) { void err; } });
      },
    };
    return controller;
  }

  function sendFiles(url, directory, files, controller, onProgress) {
    return new Promise(function (resolve, reject) {
      if (controller.cancelled) { reject(new Error('cancelled')); return; }
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url + '&directory=' + encodeURIComponent(directory));
      xhr.withCredentials = true;
      controller.active.add(xhr);
      const finish = function (fn, value) { controller.active.delete(xhr); fn(value); };
      xhr.upload.onprogress = function (event) { if (event.lengthComputable) onProgress(event.loaded); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) finish(resolve);
        else finish(reject, new Error('Upload failed (' + xhr.status + ')'));
      };
      xhr.onerror = function () { finish(reject, new Error('Network error during upload')); };
      xhr.onabort = function () { finish(reject, new Error('cancelled')); };
      xhr.send(form);
    });
  }

  async function runPool(items, limit, worker) {
    let cursor = 0;
    const runners = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) {
      runners.push((async function () {
        for (;;) {
          const index = cursor++;
          if (index >= items.length) break;
          await worker(items[index], index);
        }
      })());
    }
    await Promise.all(runners);
  }

  // plain files, no folders: upload straight to the current directory, same as the native uploader
  async function runPlainUpload(server, base, bucket, controller, cb) {
    const batches = planBatches(base, bucket.files);
    const total = sumBytes(bucket.files) || 1;
    const loadedByBatch = new Map();
    let completed = 0;
    let url = await api.uploadUrl(server);

    const report = function () {
      let live = 0;
      loadedByBatch.forEach(function (value) { live += value; });
      cb.progress(completed + live, total);
    };

    const failed = [];
    await runPool(batches, PARALLEL_REQUESTS, async function (batch, index) {
      if (controller.cancelled) return;
      const batchBytes = sumBytes(batch.items);
      const files = batch.items.map(function (x) { return x.file; });
      const onProgress = function (loaded) { loadedByBatch.set(index, loaded); report(); };
      let ok = true;
      try {
        await sendFiles(url, batch.dir, files, controller, onProgress);
      } catch (first) {
        void first;
        if (!controller.cancelled) {
          try {
            url = await api.uploadUrl(server);
            await sendFiles(url, batch.dir, files, controller, onProgress);
          } catch (second) { void second; ok = false; }
        } else ok = false;
      }
      loadedByBatch.delete(index);
      if (ok) completed += batchBytes; else failed.push(batch);
      report();
    });

    return { failed: failed.length, cancelled: controller.cancelled };
  }

  // folders present: tar.gz client-side, upload the archive(s), extract server-side, drop the archive(s)
  async function runArchiveUpload(server, base, bucket, controller, cb) {
    const groups = planArchives(bucket.files);

    cb.buildStart();
    const built = [];
    for (let i = 0; i < groups.length; i++) {
      if (controller.cancelled) return { cancelled: true };
      const blob = await buildTarGz(groups[i]);
      const name = archiveName(i);
      built.push({ name: name, file: new File([blob], name, { type: 'application/gzip' }) });
    }
    if (controller.cancelled) return { cancelled: true };

    cb.uploadStart();
    const total = built.reduce(function (sum, item) { return sum + item.file.size; }, 0) || 1;
    const loadedByIndex = new Map();
    let url = await api.uploadUrl(server);

    const report = function () {
      let live = 0;
      loadedByIndex.forEach(function (value) { live += value; });
      cb.uploadProgress(live, total);
    };

    const failed = [];
    await runPool(built, PARALLEL_REQUESTS, async function (item, index) {
      if (controller.cancelled) return;
      const onProgress = function (loaded) { loadedByIndex.set(index, loaded); report(); };
      let ok = true;
      try {
        await sendFiles(url, base, [item.file], controller, onProgress);
      } catch (first) {
        void first;
        if (!controller.cancelled) {
          try {
            url = await api.uploadUrl(server);
            await sendFiles(url, base, [item.file], controller, onProgress);
          } catch (second) { void second; ok = false; }
        } else ok = false;
      }
      loadedByIndex.set(index, item.file.size);
      report();
      if (!ok) failed.push(item);
    });

    if (controller.cancelled) return { cancelled: true };

    cb.extractStart();
    let ok = failed.length === 0;
    for (const item of built) {
      if (failed.indexOf(item) !== -1) continue;
      try {
        await api.decompress(server, base, item.name);
        await api.deleteFiles(server, base, [item.name]);
      } catch (err) { void err; ok = false; }
    }
    cb.extractDone(ok);
    return { cancelled: false, ok: ok };
  }

  // ---- bottom progress bar ----

  let bb = null;
  let bbUploadSeg = null;
  let bbUploadFill = null;
  let bbExtractSeg = null;
  let bbExtractFill = null;
  let bbSpeed = null;
  let bbTimer = null;
  let bbController = null;

  function ensureBB() {
    if (bb) return;
    bbUploadFill = el('div', { class: 'mu-bb-fill' });
    bbSpeed = el('span', { class: 'mu-bb-speed' });
    bbUploadSeg = el('div', { class: 'mu-bb-seg' }, [bbUploadFill, bbSpeed]);
    bbExtractFill = el('div', { class: 'mu-bb-fill' });
    bbExtractSeg = el('div', { class: 'mu-bb-seg' }, [bbExtractFill]);
    bb = el('div', { class: 'mu-bb', style: 'display:none', title: 'Click to cancel' }, [bbUploadSeg, bbExtractSeg]);
    bb.addEventListener('click', function () { if (bbController) bbController.cancel(); });
    document.body.appendChild(bb);
  }

  function bbShow(twoStage, controller) {
    ensureBB();
    clearTimeout(bbTimer);
    bbController = controller;
    bb.classList.toggle('mu-bb-onestage', !twoStage);
    bbUploadSeg.classList.remove('mu-bb-err', 'mu-bb-indet');
    bbExtractSeg.classList.remove('mu-bb-err', 'mu-bb-indet');
    bbUploadFill.style.width = '0%';
    bbExtractFill.style.width = '0%';
    bbSpeed.textContent = '';
    bb.style.display = '';
  }

  function bbBuildStart() {
    bbUploadSeg.classList.add('mu-bb-indet');
  }

  function bbUploadStart() {
    bbUploadSeg.classList.remove('mu-bb-indet');
  }

  function bbUploadProgress(pct, speedTxt) {
    bbUploadFill.style.width = pct + '%';
    bbSpeed.textContent = speedTxt || '';
  }

  function bbExtractStart() {
    bbUploadFill.style.width = '100%';
    bbSpeed.textContent = '';
    bbExtractSeg.classList.add('mu-bb-indet');
  }

  function bbExtractDone(ok) {
    bbExtractSeg.classList.remove('mu-bb-indet');
    bbExtractFill.style.width = '100%';
    if (!ok) bbExtractSeg.classList.add('mu-bb-err');
  }

  function bbFail(stage) {
    const seg = stage === 'extract' ? bbExtractSeg : bbUploadSeg;
    seg.classList.remove('mu-bb-indet');
    seg.classList.add('mu-bb-err');
    bbTimer = setTimeout(bbHide, 3000);
  }

  function bbHide() {
    clearTimeout(bbTimer);
    if (bb) bb.style.display = 'none';
    bbController = null;
  }

  function bottomGlow() {
    const glow = el('div', { class: 'mu-glow' });
    document.body.appendChild(glow);
    setTimeout(function () { glow.remove(); }, 1900);
  }

  function pokeRevalidate() {
    // Pterodactyl's file list revalidates on window focus / tab visibility (SWR).
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  }

  function refreshFileList() {
    // Fire a few times, spaced out, to beat SWR's focus throttle after the upload finishes.
    setTimeout(pokeRevalidate, 300);
    setTimeout(pokeRevalidate, 1200);
    setTimeout(pokeRevalidate, 2600);
  }

  // ---- orchestration ----

  function makeSpeedTracker() {
    let sampleBytes = 0;
    let sampleTime = Date.now();
    let speed = 0;
    return function (loaded) {
      const now = Date.now();
      const dt = (now - sampleTime) / 1000;
      if (dt >= 0.3) {
        const instant = (loaded - sampleBytes) / dt;
        speed = speed ? speed * 0.6 + instant * 0.4 : instant;
        sampleBytes = loaded;
        sampleTime = now;
      }
      return speed > 0 ? formatBytes(speed) + '/s' : '';
    };
  }

  let busy = false;

  async function startUploadFlow(bucket) {
    if (busy || !bucket.files.length) return;
    const server = currentServer();
    if (!server) return;
    busy = true;

    const base = currentDir();
    const hasDirs = bucket.dirs.size > 0;
    const controller = createController();
    const trackSpeed = makeSpeedTracker();
    bbShow(hasDirs, controller);

    try {
      if (!hasDirs) {
        const result = await runPlainUpload(server, base, bucket, controller, {
          progress: function (loaded, total) {
            const pct = Math.min(100, Math.round((loaded / total) * 100));
            bbUploadProgress(pct, trackSpeed(loaded));
          },
        });
        if (result.cancelled) { bbHide(); return; }
        if (result.failed) { bbFail('upload'); return; }
      } else {
        const result = await runArchiveUpload(server, base, bucket, controller, {
          buildStart: bbBuildStart,
          uploadStart: bbUploadStart,
          uploadProgress: function (loaded, total) {
            const pct = Math.min(100, Math.round((loaded / total) * 100));
            bbUploadProgress(pct, trackSpeed(loaded));
          },
          extractStart: bbExtractStart,
          extractDone: bbExtractDone,
        });
        if (result.cancelled) { bbHide(); return; }
        if (!result.ok) { bbFail('extract'); return; }
      }

      refreshFileList();
      bottomGlow();
      bbTimer = setTimeout(bbHide, 500);
    } catch (err) {
      console.error('[multiupload]', err);
      bbFail(hasDirs ? 'extract' : 'upload');
    } finally {
      busy = false;
    }
  }

  // ---- drag and drop ----

  let overlay = null;

  function ensureOverlay() {
    if (overlay) return;
    overlay = el('div', { class: 'mu-overlay', style: 'display:none' }, [
      el('div', { class: 'mu-overlay-card' }, [
        el('div', { class: 'mu-ring', html: icons.up }),
        el('strong', { text: 'Drop to upload' }),
        el('span', { text: 'Folders keep their structure' }),
      ]),
    ]);
    document.body.appendChild(overlay);
  }

  function showOverlay() { ensureOverlay(); overlay.style.display = ''; }
  function hideOverlay() { if (overlay) overlay.style.display = 'none'; }

  function dragHasFiles(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return types && Array.prototype.indexOf.call(types, 'Files') >= 0;
  }

  function setupDragAndDrop() {
    window.addEventListener('dragenter', function (e) {
      if (!onFilesPage() || !dragHasFiles(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      showOverlay();
    }, true);

    window.addEventListener('dragover', function (e) {
      if (!onFilesPage() || !dragHasFiles(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = 'copy';
    }, true);

    window.addEventListener('dragleave', function (e) {
      if (!onFilesPage() || !dragHasFiles(e)) return;
      if (e.relatedTarget) return;
      hideOverlay();
    }, true);

    window.addEventListener('drop', async function (e) {
      if (!onFilesPage() || !dragHasFiles(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hideOverlay();
      const bucket = await collectTransfer(e.dataTransfer);
      startUploadFlow(bucket);
    }, true);
  }

  // ---- action button ----

  let folderInput = null;

  function ensureFolderInput() {
    if (folderInput) return;
    folderInput = el('input', { type: 'file', webkitdirectory: '', directory: '', multiple: '', style: 'display:none' });
    folderInput.addEventListener('change', function () {
      if (folderInput.files.length) startUploadFlow(collectPicked(folderInput.files));
      folderInput.value = '';
    });
    document.body.appendChild(folderInput);
  }

  function mountActionButton() {
    if (!onFilesPage()) return;
    if (document.getElementById('mu-action')) return;
    ensureFolderInput();
    let uploadBtn = null;
    let dirBtn = null;
    const buttons = document.querySelectorAll('button');
    for (const button of buttons) {
      if (button.id === 'mu-action') continue;
      const text = (button.textContent || '').trim().toLowerCase();
      if (!uploadBtn && text === 'upload') uploadBtn = button;
      else if (!dirBtn && (text === 'new directory' || text === 'create directory')) dirBtn = button;
    }
    const anchor = uploadBtn || dirBtn;
    if (!anchor || !anchor.parentNode) return;
    const button = document.createElement('button');
    button.id = 'mu-action';
    button.type = 'button';
    button.className = anchor.className;
    button.textContent = 'Upload Folders';
    button.addEventListener('click', function () { folderInput.click(); });
    anchor.parentNode.insertBefore(button, uploadBtn || anchor);
  }

  function boot() {
    setupDragAndDrop();
    mountActionButton();
    let scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () { scheduled = false; mountActionButton(); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
