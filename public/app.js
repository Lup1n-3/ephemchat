/* EphemChat — frontend */
(function () {
    'use strict';

    var room = decodeURIComponent((location.pathname || '').replace(/^\/+|\/+$/g, ''));
    var ownerToken = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : ('t-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

    var SUGGESTED = ['hacking', 'programacion', 'offtopic', 'memes', 'cripto', 'musica', 'anon', 'ayuda'];
    var PALETTE = ['#7cc4ff', '#f0b37a', '#c7a4ff', '#7fd6a4', '#ff9b9b', '#8fd6d6', '#e3c97f', '#c9a0dc'];

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

    function nickColor(name) {
        var h = 0;
        for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
        return PALETTE[h % PALETTE.length];
    }

    function humanSize(b) {
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function hhmm(ts) { var d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

    /* ============================ PORTADA ============================ */
    if (!room) {
        var landing = document.getElementById('landing');
        var roomsEl = document.getElementById('rooms');
        var joinInput = document.getElementById('join-input');
        var joinBtn = document.getElementById('join-btn');
        landing.hidden = false;

        function makeRoomCard(name) {
            var card = document.createElement('div');
            card.className = 'room-card';
            card.dataset.room = name;
            var n = document.createElement('span'); n.className = 'name'; n.textContent = name;
            var c = document.createElement('span'); c.className = 'count zero'; c.textContent = '0';
            card.appendChild(n); card.appendChild(c);
            card.addEventListener('click', function () { location.href = '/' + encodeURIComponent(name); });
            return card;
        }

        SUGGESTED.forEach(function (name) { roomsEl.appendChild(makeRoomCard(name)); });

        function updateCounts() {
            fetch('/api/rooms', { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    var map = {};
                    (d.rooms || []).forEach(function (x) { map[x.name] = x.online; });
                    roomsEl.querySelectorAll('.room-card').forEach(function (card) {
                        var online = map[card.dataset.room] || 0;
                        var c = card.querySelector('.count');
                        c.textContent = online;
                        c.className = 'count' + (online === 0 ? ' zero' : '');
                        c.title = online === 1 ? '1 en línea' : online + ' en línea';
                    });
                })
                .catch(function () {});
        }
        updateCounts();
        setInterval(updateCounts, 5000);

        function go() {
            var n = joinInput.value.trim().replace(/[^A-Za-z0-9_-]/g, '');
            if (n) location.href = '/' + encodeURIComponent(n);
        }
        joinBtn.addEventListener('click', go);
        joinInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        return;
    }

    /* ============================ CHAT ============================ */
    document.getElementById('chat').hidden = false;
    document.getElementById('chat-room').textContent = room;
    document.getElementById('modal-room').textContent = '/' + room;

    var messagesEl = document.getElementById('messages');
    var inputEl = document.getElementById('input');
    var nickEl = document.getElementById('chat-nick');
    var statusEl = document.getElementById('status');
    var statusText = document.getElementById('status-text');
    var btnCode = document.getElementById('code-btn');
    var mdToggle = document.getElementById('md-toggle');
    var btnFile = document.getElementById('file-btn');
    var btnSend = document.getElementById('send');
    var fileInput = document.getElementById('file-input');
    var langSel = document.getElementById('lang');
    var progressEl = document.getElementById('upload-progress');
    var usersEl = document.getElementById('users');
    var usersList = document.getElementById('users-list');
    var usersCount = document.getElementById('users-count');
    var usersToggle = document.getElementById('users-toggle');
    var usersBackdrop = document.getElementById('users-backdrop');
    var usersClose = document.getElementById('users-close');
    var overlay = document.getElementById('overlay');
    var modalNick = document.getElementById('modal-nick');
    var modalJoin = document.getElementById('modal-join');
    var modalCancel = document.getElementById('modal-cancel');

    var ws = null;
    var reconnectDelay = 500;
    var codeMode = false;
    var mdOn = true;
    try { mdOn = localStorage.getItem('ec_md') !== '0'; } catch (e) {}
    var myFiles = new Set();
    var deadFiles = new Set();
    var messageLog = [];
    var stick = true;

    mdToggle.classList.toggle('on', mdOn);
    updateHint();

    function updateHint() {
        document.querySelector('.hint').innerHTML = mdOn
            ? 'Markdown <b>activado</b> · bloques de código con ``` · archivos efímeros · nada queda guardado.'
            : 'Markdown <b>desactivado</b> · los mensajes se muestran como texto plano.';
    }

    function nick() {
        var n = nickEl.value.replace(/[\x00-\x1f\x7f]/g, '').trim();
        return n || 'anon';
    }

    function setStatus(state) {
        statusEl.className = 'status ' + state;
        statusText.textContent = state === 'online' ? 'conectado' : (state === 'offline' ? 'reconectando…' : 'conectando…');
    }

    function showProgress(t) { progressEl.textContent = t; progressEl.hidden = false; }
    function hideProgress() { progressEl.hidden = true; progressEl.textContent = ''; }

    /* ---------- render de mensajes ---------- */
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

    function makeHead(nickName, ts) {
        var head = document.createElement('div');
        head.className = 'head';
        var time = document.createElement('span');
        time.className = 'time';
        time.textContent = hhmm(ts);
        var n = document.createElement('span');
        n.className = 'nick';
        n.textContent = nickName;
        n.style.color = nickColor(nickName);
        head.appendChild(time); head.appendChild(n);
        return head;
    }

    function renderOne(m) {
        var wrap = document.createElement('div');
        if (m.t === 'system') {
            wrap.className = 'sys';
            wrap.textContent = m.text;
            messagesEl.appendChild(wrap);
            return;
        }

        wrap.className = 'msg';
        wrap.appendChild(makeHead(m.nick || 'anon', m.ts));

        var body = document.createElement('div');
        body.className = 'body';

        if (m.t === 'file') {
            body = null;
            wrap.appendChild(renderFileCard(m));
        } else if (m.kind === 'code') {
            body.appendChild(makeCodeBlock(m.text));
        } else if (mdOn) {
            body.innerHTML = renderMarkdown(m.text || '');
            highlight(body);
        } else {
            body.classList.add('plain');
            body.textContent = m.text || '';
        }

        if (body) wrap.appendChild(body);
        messagesEl.appendChild(wrap);
    }

    function makeCodeBlock(text) {
        var pre = document.createElement('pre');
        var code = document.createElement('code');
        code.textContent = text;
        pre.appendChild(code);
        addCopy(pre, text);
        try { hljs.highlightElement(code); } catch (e) {}
        return pre;
    }

    function renderFileCard(m) {
        var card = document.createElement('div');
        card.className = 'file-card';
        card.setAttribute('data-share-id', m.shareId);

        var dead = deadFiles.has(m.shareId);

        var icon = document.createElement('div');
        icon.className = 'ficon';
        icon.textContent = (m.name || '').split('.').pop().toUpperCase().slice(0, 3) || 'FILE';

        var meta = document.createElement('div');
        meta.className = 'fmeta';
        var fname = document.createElement('div');
        fname.className = 'fname';
        fname.textContent = m.name;
        var fsize = document.createElement('div');
        fsize.className = 'fsize';
        fsize.textContent = humanSize(m.size);
        meta.appendChild(fname); meta.appendChild(fsize);

        card.appendChild(icon); card.appendChild(meta);

        if (dead) {
            card.classList.add('dead');
            var span = document.createElement('span');
            span.className = 'fsize';
            span.textContent = 'cancelado';
            card.appendChild(span);
        } else {
            var dl = document.createElement('a');
            dl.href = '/api/download/' + encodeURIComponent(m.shareId);
            dl.textContent = 'descargar';
            dl.setAttribute('download', '');
            card.appendChild(dl);
            if (myFiles.has(m.shareId)) {
                var cancel = document.createElement('button');
                cancel.className = 'cancel';
                cancel.textContent = 'cancelar';
                cancel.addEventListener('click', function () { cancelFile(m.shareId); });
                card.appendChild(cancel);
            }
        }
        return card;
    }

    function renderAll() {
        messagesEl.innerHTML = '';
        messageLog.forEach(renderOne);
        scrollIfNear();
    }

    function markOwnedInDOM(shareId) {
        messagesEl.querySelectorAll('.file-card[data-share-id="' + shareId + '"]').forEach(function (card) {
            if (card.querySelector('.cancel')) return;
            var cancel = document.createElement('button');
            cancel.className = 'cancel';
            cancel.textContent = 'cancelar';
            cancel.addEventListener('click', function () { cancelFile(shareId); });
            card.appendChild(cancel);
        });
    }

    function markDeadInDOM(shareId) {
        messagesEl.querySelectorAll('.file-card[data-share-id="' + shareId + '"]').forEach(function (card) {
            card.classList.add('dead');
            var cancel = card.querySelector('.cancel'); if (cancel) cancel.remove();
            var a = card.querySelector('a');
            if (a) { var s = document.createElement('span'); s.className = 'fsize'; s.textContent = 'cancelado'; a.replaceWith(s); }
        });
    }

    function renderUsers(users) {
        usersList.innerHTML = '';
        var total = 0;
        (users || []).forEach(function (u) {
            total += u.count;
            var li = document.createElement('li');
            li.textContent = u.nick + (u.count > 1 ? ' ×' + u.count : '');
            usersList.appendChild(li);
        });
        usersCount.textContent = total;
    }

    /* ---------- servidor ---------- */
    function handle(m) {
        if (m.type === 'message') {
            messageLog.push({ t: 'message', ts: Date.now(), nick: m.nick, text: m.text, kind: m.kind });
            renderOne(messageLog[messageLog.length - 1]);
            scrollIfNear();
        } else if (m.type === 'file') {
            messageLog.push({ t: 'file', ts: Date.now(), nick: m.nick, shareId: m.shareId, name: m.name, size: m.size });
            renderOne(messageLog[messageLog.length - 1]);
            scrollIfNear();
        } else if (m.type === 'file-removed') {
            deadFiles.add(m.shareId);
            myFiles.delete(m.shareId);
            markDeadInDOM(m.shareId);
        } else if (m.type === 'system') {
            messageLog.push({ t: 'system', ts: Date.now(), text: m.text });
            renderOne(messageLog[messageLog.length - 1]);
            scrollIfNear();
        } else if (m.type === 'users') {
            renderUsers(m.users);
        }
    }

    function connect() {
        setStatus('connecting');
        var proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(proto + '://' + location.host + '/ws?room=' + encodeURIComponent(room) +
            '&token=' + encodeURIComponent(ownerToken) + '&nick=' + encodeURIComponent(nick()));
        ws.onopen = function () { setStatus('online'); reconnectDelay = 500; };
        ws.onmessage = function (ev) {
            var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            handle(m);
        };
        ws.onclose = function () {
            setStatus('offline');
            myFiles.clear();
            setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 8000);
        };
        ws.onerror = function () {};
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
            if (e.lengthComputable) showProgress('subiendo ' + file.name + '… ' + Math.round(e.loaded / e.total * 100) + '%');
        };
        xhr.onload = function () {
            hideProgress();
            try {
                var d = JSON.parse(xhr.responseText);
                if (d.ok && d.shareId) { myFiles.add(d.shareId); markOwnedInDOM(d.shareId); }
                else { showProgress('Error: ' + (d.error || 'desconocido')); setTimeout(hideProgress, 3000); }
            } catch (e) { showProgress('Error de subida'); setTimeout(hideProgress, 3000); }
        };
        xhr.onerror = function () { hideProgress(); showProgress('Error de subida'); setTimeout(hideProgress, 3000); };
        xhr.send(fd);
    }

    function cancelFile(shareId) {
        myFiles.delete(shareId);
        deadFiles.add(shareId);
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
        btnCode.classList.toggle('on', codeMode);
        inputEl.focus();
    });

    mdToggle.addEventListener('click', function () {
        mdOn = !mdOn;
        mdToggle.classList.toggle('on', mdOn);
        try { localStorage.setItem('ec_md', mdOn ? '1' : '0'); } catch (e) {}
        updateHint();
        renderAll();
    });

    btnFile.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
        var f = fileInput.files[0];
        fileInput.value = '';
        if (f) uploadFile(f);
    });

    function setUsersPanel(open) {
        usersEl.hidden = !open;
        usersBackdrop.hidden = !open;
        usersToggle.classList.toggle('on', open);
    }

    usersToggle.addEventListener('click', function () {
        setUsersPanel(usersEl.hidden);
    });
    usersClose.addEventListener('click', function () {
        setUsersPanel(false);
    });
    usersBackdrop.addEventListener('click', function () {
        setUsersPanel(false);
    });

    usersToggle.classList.toggle('on', !usersEl.hidden);
    // En móvil el panel de usuarios se oculta por defecto (se muestra como overlay).
    if (window.innerWidth <= 768) {
        setUsersPanel(false);
    }

    nickEl.addEventListener('input', function () {
        try { sessionStorage.setItem('ec_nick', nickEl.value); } catch (e) {}
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'setnick', nick: nick() }));
        }
    });

    window.addEventListener('pagehide', function () {
        if (ws) { try { ws.close(); } catch (e) {} }
    });

    /* ---------- modal de apodo ---------- */
    var savedNick = '';
    try { savedNick = sessionStorage.getItem('ec_nick') || ''; } catch (e) {}
    modalNick.value = savedNick || ('anon_' + Math.random().toString(36).slice(2, 6));
    overlay.hidden = false;
    modalNick.focus();
    modalNick.select();

    function join() {
        var v = modalNick.value.replace(/[\x00-\x1f\x7f]/g, '').trim() || 'anon';
        nickEl.value = v;
        try { sessionStorage.setItem('ec_nick', v); } catch (e) {}
        overlay.hidden = true;
        connect();
    }
    modalJoin.addEventListener('click', join);
    modalNick.addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
    modalCancel.addEventListener('click', function () { location.href = '/'; });
})();
