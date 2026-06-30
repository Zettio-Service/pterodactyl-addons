(function () {
  if (window.__muLoaded) return;
  window.__muLoaded = true;

  const MAX_FILES_PER_REQUEST = 40;
  const MAX_BYTES_PER_REQUEST = 48 * 1024 * 1024;
  const PARALLEL_REQUESTS = 3;

  const icons = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V8"/><path d="M6 14l6-6 6 6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
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

  function formatTime(seconds) {
    seconds = Math.round(seconds);
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
    const hours = Math.floor(minutes / 60);
    return hours + 'h ' + (minutes % 60) + 'm';
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

  function baseName(path) {
    return path.split('/').filter(Boolean).pop() || '';
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
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('Failed to request an upload url (' + res.status + ')');
      const data = await res.json();
      return data.attributes.url;
    },
    async makeFolder(server, root, name) {
      const res = await fetch('/api/client/servers/' + server + '/files/create-folder', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: root, name: name }),
      });
      return res.ok;
    },
  };

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

  function modelFromItems(items) {
    const model = { files: items, dirs: new Set() };
    for (const item of items) {
      const segments = item.path.split('/').slice(0, -1);
      let acc = '';
      for (const seg of segments) {
        acc = acc ? acc + '/' + seg : seg;
        model.dirs.add(acc);
      }
    }
    return model;
  }

  function leafDirs(dirSet) {
    const all = Array.from(dirSet);
    return all.filter(function (dir) {
      for (const other of all) {
        if (other !== dir && other.indexOf(dir + '/') === 0) return false;
      }
      return true;
    });
  }

  async function ensureLeaf(server, base, rel) {
    if (await api.makeFolder(server, base, rel)) return;
    const segments = rel.split('/').filter(Boolean);
    let acc = base;
    for (const seg of segments) {
      await api.makeFolder(server, acc, seg);
      acc = acc === '/' ? '/' + seg : acc + '/' + seg;
    }
  }

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

  function sendBatch(url, directory, files, controller, onProgress) {
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
        while (true) {
          const index = cursor++;
          if (index >= items.length) break;
          await worker(items[index], index);
        }
      })());
    }
    await Promise.all(runners);
  }

  async function runUpload(server, base, model, controller, cb) {
    const leaves = leafDirs(model.dirs).sort(function (a, b) { return a.split('/').length - b.split('/').length; });
    for (let i = 0; i < leaves.length; i++) {
      if (controller.cancelled) break;
      cb.stage('Preparing folders ' + (i + 1) + '/' + leaves.length, true);
      await ensureLeaf(server, base, leaves[i]);
    }

    const batches = planBatches(base, model.files);
    const total = sumBytes(model.files) || 1;
    const succeeded = new Set();
    const loadedByBatch = new Map();
    let completed = 0;
    let url = await api.uploadUrl(server);

    cb.stage('Uploading', false);
    const report = function () {
      let live = 0;
      loadedByBatch.forEach(function (value) { live += value; });
      cb.progress(completed + live, total);
    };

    await runPool(batches, PARALLEL_REQUESTS, async function (batch, index) {
      if (controller.cancelled) return;
      for (const item of batch.items) if (item.row) item.row.classList.add('mu-active');
      const batchBytes = sumBytes(batch.items);
      const files = batch.items.map(function (x) { return x.file; });
      const onProgress = function (loaded) { loadedByBatch.set(index, loaded); report(); };
      let ok = true;
      try {
        await sendBatch(url, batch.dir, files, controller, onProgress);
      } catch (first) {
        void first;
        if (!controller.cancelled) {
          try {
            url = await api.uploadUrl(server);
            await sendBatch(url, batch.dir, files, controller, onProgress);
          } catch (second) { void second; ok = false; }
        } else ok = false;
      }
      loadedByBatch.delete(index);
      if (ok) completed += batchBytes;
      report();
      for (const item of batch.items) {
        if (item.row) item.row.classList.remove('mu-active');
        if (ok) { succeeded.add(item); if (item.row) item.row.classList.add('mu-ok'); }
        else if (item.row) item.row.classList.add('mu-err');
      }
    });

    const failedItems = model.files.filter(function (item) { return !succeeded.has(item); });
    return { ok: model.files.length - failedItems.length, failed: failedItems.length, failedItems: failedItems, cancelled: controller.cancelled };
  }

  let dock = null;
  let dockText = null;
  let dockPct = null;
  let dockTimer = null;

  function ensureDock() {
    if (dock) return;
    dockText = el('span', { class: 'mu-dock-text' });
    dockPct = el('span', { class: 'mu-dock-pct' });
    dock = el('div', { class: 'mu-dock', style: 'display:none' }, [
      el('span', { class: 'mu-dock-ic', html: icons.folder }),
      dockText,
      dockPct,
    ]);
    document.body.appendChild(dock);
  }

  function dockLabel(model) {
    if (model.dirs.size) return model.dirs.size + ' folder' + (model.dirs.size === 1 ? '' : 's');
    return model.files.length + ' file' + (model.files.length === 1 ? '' : 's');
  }

  function dockShow(label) {
    ensureDock();
    clearTimeout(dockTimer);
    dock.classList.remove('mu-dock-done');
    dock.classList.add('mu-indet');
    dock.style.setProperty('--p', 0);
    dock.dataset.label = label;
    dockText.textContent = 'Uploading ' + label;
    dockPct.textContent = '';
    dock.style.display = '';
  }

  function dockStage(text, indeterminate) {
    if (!dock) return;
    dock.classList.toggle('mu-indet', !!indeterminate);
    dockText.textContent = text + ', ' + dock.dataset.label;
  }

  function dockProgress(p) {
    if (!dock) return;
    dock.classList.remove('mu-indet');
    dock.style.setProperty('--p', p);
    dockText.textContent = 'Uploading ' + dock.dataset.label;
    dockPct.textContent = p + '%';
  }

  function dockDone(text) {
    if (!dock) return;
    dock.classList.remove('mu-indet');
    dock.classList.add('mu-dock-done');
    dock.style.setProperty('--p', 100);
    dockText.textContent = text;
    dockPct.textContent = '';
    dockTimer = setTimeout(function () { if (dock) dock.style.display = 'none'; }, 4500);
  }

  function hideDock() {
    if (!dock) return;
    clearTimeout(dockTimer);
    dock.style.display = 'none';
  }

  function bottomGlow() {
    const glow = el('div', { class: 'mu-glow' });
    document.body.appendChild(glow);
    setTimeout(function () { glow.remove(); }, 1900);
  }

  function refreshFileList() {
    setTimeout(function () { window.dispatchEvent(new Event('focus')); }, 400);
  }

  async function dockOnlyUpload(server, base, model) {
    const label = dockLabel(model);
    dockShow(label);
    const controller = createController();
    const cb = {
      stage: function (text, indeterminate) { dockStage(text, indeterminate); },
      progress: function (loaded, total) { dockProgress(Math.min(100, Math.round((loaded / total) * 100))); },
    };
    let result;
    try {
      result = await runUpload(server, base, model, controller, cb);
    } catch (err) {
      void err;
      dockDone('Upload failed');
      return;
    }
    if (result.failed) dockDone(result.ok + ' of ' + (result.ok + result.failed) + ' uploaded');
    else { hideDock(); bottomGlow(); }
    refreshFileList();
  }

  let currentAdd = null;
  let currentDropEl = null;

  function openModal(initial, autostart) {
    const server = currentServer();
    if (!server) return;

    const model = { files: [], dirs: new Set(), seen: new Set() };
    let uploading = false;

    const summary = el('div', { class: 'mu-summary mu-empty' });
    const list = el('div', { class: 'mu-list' });
    const goBtn = el('button', { class: 'mu-go', text: 'Upload', disabled: '' });

    function add(bucket) {
      if (uploading) return;
      for (const dir of bucket.dirs) model.dirs.add(dir);
      for (const item of bucket.files) {
        const key = item.path + ':' + item.file.size;
        if (model.seen.has(key)) continue;
        model.seen.add(key);
        model.files.push(item);
      }
      renderSummary();
    }

    function renderSummary() {
      const count = model.files.length;
      const total = sumBytes(model.files);
      summary.className = 'mu-summary' + (count ? '' : ' mu-empty');
      summary.innerHTML = '';
      summary.appendChild(el('div', { html: '<b>' + count + '</b> file' + (count === 1 ? '' : 's') }));
      summary.appendChild(el('div', { html: '<b>' + model.dirs.size + '</b> folder' + (model.dirs.size === 1 ? '' : 's') }));
      summary.appendChild(el('div', { html: '<b>' + formatBytes(total) + '</b> total' }));
      list.innerHTML = '';
      const shown = model.files.slice(0, 200);
      for (const item of shown) {
        item.row = el('div', { class: 'mu-row' }, [
          el('span', { class: 'mu-dot' }),
          el('span', { class: 'mu-path', text: item.path }),
          el('span', { class: 'mu-size', text: formatBytes(item.file.size) }),
        ]);
        list.appendChild(item.row);
      }
      if (model.files.length > shown.length) {
        list.appendChild(el('div', { class: 'mu-row', text: '+ ' + (model.files.length - shown.length) + ' more' }));
      }
      list.style.display = count ? '' : 'none';
      goBtn.disabled = !count;
    }

    const folderInput = el('input', { type: 'file', webkitdirectory: '', directory: '', multiple: '', style: 'display:none' });
    const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
    folderInput.addEventListener('change', function () { if (folderInput.files.length) add(collectPicked(folderInput.files)); folderInput.value = ''; });
    fileInput.addEventListener('change', function () { if (fileInput.files.length) add(collectPicked(fileInput.files)); fileInput.value = ''; });

    const drop = el('div', { class: 'mu-drop' }, [
      el('div', { class: 'mu-ring', html: icons.up }),
      el('strong', { text: 'Drop folders or files here' }),
      el('span', { text: 'Drop anywhere on the page, trees stay intact and nothing gets zipped' }),
      el('div', { class: 'mu-pick' }, [
        el('button', { onclick: function () { folderInput.click(); } }, [el('span', { html: icons.folder }), 'Select folder']),
        el('button', { onclick: function () { fileInput.click(); } }, [el('span', { html: icons.file }), 'Select files']),
      ]),
      folderInput,
      fileInput,
    ]);

    const progress = el('div', { class: 'mu-progress', style: 'display:none' });
    const bar = el('div', { class: 'mu-bar' });
    const metaLeft = el('b', { text: '0%' });
    const metaRight = el('span', { text: '' });
    progress.appendChild(el('div', { class: 'mu-track' }, [bar]));
    progress.appendChild(el('div', { class: 'mu-meta' }, [metaLeft, metaRight]));

    const foot = el('div', { class: 'mu-foot' });
    const body = el('div', { class: 'mu-body' }, [drop, summary, list, progress]);

    const closeBtn = el('button', { class: 'mu-x', text: '×' });
    const head = el('div', { class: 'mu-head' }, [
      el('div', { class: 'mu-badge', html: icons.folder }),
      el('div', {}, [el('h2', { text: 'Multi upload' }), el('p', { text: 'Destination: ' + currentDir() })]),
      closeBtn,
    ]);

    const card = el('div', { class: 'mu-card' }, [head, body, foot]);
    const backdrop = el('div', { class: 'mu-backdrop' }, [card]);

    function close() {
      if (backdrop.classList.contains('mu-closing')) return;
      document.removeEventListener('keydown', onKey);
      currentAdd = null;
      currentDropEl = null;
      backdrop.classList.add('mu-closing');
      setTimeout(function () { backdrop.remove(); }, 200);
    }
    function onKey(e) { if (e.key === 'Escape' && !uploading) close(); }
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop && !uploading) close(); });
    closeBtn.addEventListener('click', function () { if (!uploading) close(); });
    document.addEventListener('keydown', onKey);

    function idleFoot() {
      foot.innerHTML = '';
      foot.appendChild(el('button', { text: 'Cancel', onclick: function () { if (!uploading) close(); } }));
      foot.appendChild(el('div', { class: 'mu-spacer' }));
      foot.appendChild(goBtn);
    }

    function startUpload(uploadModel) {
      uploading = true;
      const base = currentDir();
      const label = dockLabel(uploadModel);
      dockShow(label);

      drop.style.display = 'none';
      summary.style.display = 'none';
      list.style.display = '';
      progress.style.display = '';
      bar.classList.remove('mu-finished');
      const previousDone = body.querySelector('.mu-done');
      if (previousDone) previousDone.remove();

      const controller = createController();
      const prog = { loaded: 0, total: sumBytes(uploadModel.files) || 1 };
      let sampleBytes = 0;
      let sampleTime = Date.now();
      let speed = 0;

      const ticker = setInterval(function () {
        const now = Date.now();
        const dt = (now - sampleTime) / 1000;
        if (dt >= 0.3) {
          const instant = (prog.loaded - sampleBytes) / dt;
          speed = speed ? speed * 0.6 + instant * 0.4 : instant;
          sampleBytes = prog.loaded;
          sampleTime = now;
        }
        const remaining = Math.max(0, prog.total - prog.loaded);
        const eta = speed > 1 ? remaining / speed : 0;
        metaRight.textContent = (speed > 0 ? formatBytes(speed) + '/s' : '') + (eta > 0 ? ', ~' + formatTime(eta) : '');
      }, 600);

      foot.innerHTML = '';
      const abortBtn = el('button', { text: 'Cancel' });
      abortBtn.addEventListener('click', function () {
        controller.cancel();
        abortBtn.disabled = true;
        abortBtn.textContent = 'Stopping…';
      });
      foot.appendChild(abortBtn);
      foot.appendChild(el('div', { class: 'mu-spacer' }));

      const cb = {
        stage: function (text, indeterminate) {
          dockStage(text, indeterminate);
          if (indeterminate) metaRight.textContent = text;
        },
        progress: function (loaded, total) {
          prog.loaded = loaded;
          const p = Math.min(100, Math.round((loaded / total) * 100));
          bar.style.width = p + '%';
          metaLeft.textContent = p + '%';
          dockProgress(p);
        },
      };

      runUpload(server, base, uploadModel, controller, cb).then(function (result) {
        clearInterval(ticker);
        uploading = false;
        finishUpload(result, prog);
      }).catch(function (err) {
        clearInterval(ticker);
        uploading = false;
        metaRight.textContent = err.message;
        dockDone('Upload failed');
        foot.innerHTML = '';
        foot.appendChild(el('button', { text: 'Close', onclick: close }));
      });
    }

    function finishUpload(result, prog) {
      hideDock();
      refreshFileList();

      if (!result.failed && !result.cancelled) {
        bottomGlow();
        setTimeout(close, 500);
        return;
      }

      const percent = Math.min(100, Math.round((prog.loaded / prog.total) * 100));
      bar.classList.add('mu-finished');
      bar.style.width = percent + '%';
      metaLeft.textContent = percent + '%';
      metaRight.textContent = '';

      body.appendChild(el('div', { class: 'mu-done' }, [
        el('div', { class: 'mu-check mu-check-warn', html: icons.check }),
        el('strong', { text: result.cancelled ? 'Upload stopped' : (result.ok + ' uploaded, ' + result.failed + ' failed') }),
        el('span', { class: 'mu-size', text: 'Retry the files that did not make it' }),
      ]));

      foot.innerHTML = '';
      foot.appendChild(el('button', { text: 'Close', onclick: close }));
      foot.appendChild(el('div', { class: 'mu-spacer' }));
      if (result.failedItems.length) {
        foot.appendChild(el('button', { class: 'mu-go', text: 'Retry failed (' + result.failedItems.length + ')', onclick: function () {
          const items = result.failedItems;
          for (const item of items) if (item.row) item.row.classList.remove('mu-err', 'mu-ok');
          startUpload(modelFromItems(items));
        } }));
      }
    }

    goBtn.addEventListener('click', function () { startUpload(model); });

    idleFoot();
    renderSummary();
    document.body.appendChild(backdrop);
    currentAdd = add;
    currentDropEl = drop;
    if (initial) add(initial);
    if (initial && autostart && model.files.length) startUpload(model);
  }

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
      if (currentDropEl) currentDropEl.classList.add('mu-hot');
      else showOverlay();
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
      if (currentDropEl) currentDropEl.classList.remove('mu-hot');
    }, true);

    window.addEventListener('drop', async function (e) {
      if (!onFilesPage() || !dragHasFiles(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hideOverlay();
      if (currentDropEl) currentDropEl.classList.remove('mu-hot');
      const bucket = await collectTransfer(e.dataTransfer);
      if (!bucket.files.length) return;
      if (currentAdd) { currentAdd(bucket); return; }
      if (bucket.dirs.size) { openModal(bucket, true); return; }
      const server = currentServer();
      if (server) dockOnlyUpload(server, currentDir(), bucket);
    }, true);
  }

  function mountActionButton() {
    if (!onFilesPage()) return;
    if (document.getElementById('mu-action')) return;
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
    button.addEventListener('click', function () { openModal(); });
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
