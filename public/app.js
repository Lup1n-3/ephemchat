/* EphemChat — frontend (WebSocket, efímero) */
(function () {
    'use strict';

    var room = decodeURIComponent((location.pathname || '').replace(/^\/+|\/+$/g, ''));
    var ownerToken = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : ('t-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

    /* ---------- portada ---------- */
    if (!room) {
        document.getElementById('view-landing').hidden = false;
        document.getElementById('room-form').addEventListener('submit', function (e) {
            e.preventDefault();
            var name = document.getElementById('room-input').value.trim()
                .replace(/[^A-Za-z0-9_-]/g, '');
            if (name) location.href = '/' + encodeURIComponent(name);
        });
        return;
    }

    document.getElementById('view-chat').hidden = false;
    document.getElementById('room-name').textContent = room;

    var messagesEl = document.getElementById('messages');
    var inputEl = document.getElementById('input');
    var nickEl = document.getElementById('nick');
    var statusEl = document.getElementById('status');
    var btnCode = document.getElementById('btn-code');
    var btnFile = document.getElementById('btn-file');
    var btnSend = document.getElementById('btn-send');
    var fileInput = document.getElementById('file-input');
    var langSel = document.getElementById('lang');
    var progressEl = document.getElementById('upload-progress');

    var ws = null;
    var reconnectDelay = 500;
    var codeMode = false;
    var myFiles = new Set();
    var stick = true;

    /* ---------- markdown / sanitizado ---------- */
    marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });

    DOMPurify.addHook('afterSanitizeAttributes', function (node) {
        if (node.tagName === 'A') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
        }
    });

    function renderMarkdown(text) {
        return DOMPurify.sanitize(marked.parse(text));
    }

    /* ---------- utilidades ---------- */
    function nickHue(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
        return h % 360;
    }

    function humanSize(b) {
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    }

    function nick() {
        var n = nickEl.value.replace(/[\x00-\x1f\x7f]/g, '').trim();
        return n || 'anon';
    }

    function setStatus(state) {
        statusEl.className = 'status status-' + state;
        statusEl.textContent = state === 'online' ? 'conectado' : (state === 'offline' ? 'reconectando…' : 'conectando…');
    }

    function showProgress(t) { progressEl.textContent = t; progressEl.hidden = false; }
    function hideProgress() { progressEl.hidden = true; progressEl.textContent = ''; }

    /* ---------- render ---------- */
    function addCopy(pre, text) {
        if (pre.querySelector('.copy-btn')) return;
        var btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'copiar';
        btn.addEventListener('click', function () {
            var done = function () { btn.textContent = '✓'; setTimeout(function () { btn.textContent = 'copiar'; }, 1200); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(function () {});
            } else { done(); }
        });
        pre.appendChild(btn);
    }

    function highlight(root) {
        root.querySelectorAll('pre code').forEach(function (code) {
            addCopy(code.parentElement, code.textContent);
            try { hljs.highlightElement(code); } catch (e) { /* noop */ }
        });
    }

    function nickLabel(name) {
        var span = document.createElement('span');
        span.className = 'nick';
        span.textContent = name;
        span.style.color = 'hsl(' + nickHue(name) + ',70%,65%)';
        return span;
    }

    function addMessage(m) {
        var wrap = document.createElement('div');
        wrap.className = 'msg';

        if (m.kind === 'code') {
            var pre = document.createElement('pre');
            var code = document.createElement('code');
            code.textContent = m.text;
            pre.appendChild(code);
            addCopy(pre, m.text);
            var body = document.createElement('div');
            body.className = 'body';
            body.appendChild(pre);
            wrap.appendChild(nickLabel(m.nick || 'anon'));
            wrap.appendChild(body);
        } else {
            var body2 = document.createElement('div');
            body2.className = 'body';
            body2.innerHTML = renderMarkdown(m.text || '');
            highlight(body2);
            wrap.appendChild(nickLabel(m.nick || 'anon'));
            wrap.appendChild(body2);
        }

        messagesEl.appendChild(wrap);
        scrollIfNear();
    }

    function addSystem(text) {
        var wrap = document.createElement('div');
        wrap.className = 'msg-system';
        wrap.textContent = text;
        messagesEl.appendChild(wrap);
        scrollIfNear();
    }

    function addFile(m) {
        var wrap = document.createElement('div');
        wrap.className = 'msg';

        var card = document.createElement('div');
        card.className = 'file-card';
        card.setAttribute('data-share-id', m.shareId);

        var icon = document.createElement('span');
        icon.className = 'ficon';
        icon.textContent = '📄';

        var meta = document.createElement('div');
        meta.className = 'fmeta';
        var fname = document.createElement('div');
        fname.className = 'fname';
        fname.textContent = m.name;
        var fsize = document.createElement('div');
        fsize.className = 'fsize';
        fsize.textContent = humanSize(m.size);
        meta.appendChild(fname);
        meta.appendChild(fsize);

        var dl = document.createElement('a');
        dl.href = '/api/download/' + encodeURIComponent(m.shareId);
        dl.textContent = 'Descargar';
        dl.setAttribute('download', '');

        card.appendChild(icon);
        card.appendChild(meta);
        card.appendChild(dl);

        wrap.appendChild(nickLabel((m.nick || 'anon') + ' compartió:'));
        wrap.appendChild(card);

        if (myFiles.has(m.shareId)) addCancelButton(card, m.shareId);
        messagesEl.appendChild(wrap);
        scrollIfNear();
    }

    function addCancelButton(card, shareId) {
        if (card.querySelector('.cancel')) return;
        var cancel = document.createElement('button');
        cancel.className = 'cancel';
        cancel.textContent = 'Cancelar';
        cancel.addEventListener('click', function () { cancelFile(shareId); });
        card.appendChild(cancel);
    }

    function markOwnedInDOM(shareId) {
        messagesEl.querySelectorAll('.file-card[data-share-id="' + shareId + '"]').forEach(function (c) {
            addCancelButton(c, shareId);
        });
    }

    function markDeadInDOM(shareId) {
        messagesEl.querySelectorAll('.file-card[data-share-id="' + shareId + '"]').forEach(function (c) {
            c.classList.add('dead');
            var cancel = c.querySelector('.cancel');
            if (cancel) cancel.remove();
            var a = c.querySelector('a');
            if (a) { a.textContent = 'Cancelado'; a.removeAttribute('href'); }
        });
    }

    /* ---------- WebSocket ---------- */
    function connect() {
        setStatus('connecting');
        var proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(proto + '://' + location.host + '/ws?room=' + encodeURIComponent(room) + '&token=' + encodeURIComponent(ownerToken));

        ws.onopen = function () {
            setStatus('online');
            reconnectDelay = 500;
        };
        ws.onmessage = function (ev) {
            var m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.type === 'message') addMessage(m);
            else if (m.type === 'file') addFile(m);
            else if (m.type === 'file-removed') { myFiles.delete(m.shareId); markDeadInDOM(m.shareId); }
            else if (m.type === 'system') addSystem(m.text);
        };
        ws.onclose = function () {
            setStatus('offline');
            myFiles.clear();
            setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 8000);
        };
        ws.onerror = function () { /* onclose se encarga */ };
    }

    /* ---------- envío ---------- */
    function send() {
        var text = inputEl.value.replace(/\s+$/, '');
        if (!text.trim()) return;

        var kind = 'md';
        if (codeMode) {
            var lang = langSel.value;
            text = '```' + (lang && lang !== 'auto' ? lang : '') + '\n' + text + '\n```';
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'message', nick: nick(), text: text, kind: kind }));
        }
        inputEl.value = '';
        autosize();
    }

    /* ---------- archivos ---------- */
    function uploadFile(file) {
        var fd = new FormData();
        fd.append('room', room);
        fd.append('token', ownerToken);
        fd.append('nick', nick());
        fd.append('file', file);

        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) {
                showProgress('Subiendo ' + file.name + '… ' + Math.round(e.loaded / e.total * 100) + '%');
            }
        };
        xhr.onload = function () {
            hideProgress();
            try {
                var d = JSON.parse(xhr.responseText);
                if (d.ok && d.shareId) {
                    myFiles.add(d.shareId);
                    markOwnedInDOM(d.shareId);
                } else {
                    showProgress('Error: ' + (d.error || 'desconocido'));
                    setTimeout(hideProgress, 3000);
                }
            } catch (e) {
                showProgress('Error de subida');
                setTimeout(hideProgress, 3000);
            }
        };
        xhr.onerror = function () {
            hideProgress();
            showProgress('Error de subida');
            setTimeout(hideProgress, 3000);
        };
        xhr.send(fd);
    }

    function cancelFile(shareId) {
        myFiles.delete(shareId);
        markDeadInDOM(shareId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'file-cancel', shareId: shareId }));
        }
    }

    /* ---------- UI ---------- */
    function autosize() {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    }

    function scrollIfNear() {
        if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    messagesEl.addEventListener('scroll', function () {
        stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    });

    inputEl.addEventListener('input', autosize);
    inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    btnSend.addEventListener('click', send);

    btnCode.addEventListener('click', function () {
        codeMode = !codeMode;
        btnCode.classList.toggle('active', codeMode);
        inputEl.focus();
    });

    btnFile.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
        var f = fileInput.files[0];
        fileInput.value = '';
        if (f) uploadFile(f);
    });

    try {
        var savedNick = sessionStorage.getItem('ec_nick');
        if (savedNick) nickEl.value = savedNick;
        else nickEl.value = 'anon_' + Math.random().toString(36).slice(2, 6);
    } catch (e) {
        nickEl.value = 'anon_' + Math.random().toString(36).slice(2, 6);
    }
    nickEl.addEventListener('input', function () {
        try { sessionStorage.setItem('ec_nick', nickEl.value); } catch (e) {}
    });

    // Al cerrar la pestaña se cierra el WS y el servidor borra los archivos del dueño.
    window.addEventListener('pagehide', function () {
        if (ws) { try { ws.close(); } catch (e) {} }
    });

    connect();
})();
