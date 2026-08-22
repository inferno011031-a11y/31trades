/* BattlexJournal — standalone test chatbot widget (landing page)
   ---------------------------------------------------------------------------
   Free-form Gemini chat via POST /api/chat-test. This widget is deliberately
   NOT connected to any journal data — it is a testing chat. Session memory
   only (a JS array in this closure; nothing persisted, nothing stored).

   XSS-safe: all user/assistant text is rendered via textContent. The only
   innerHTML use is the static, fully-literal widget skeleton below.
   --------------------------------------------------------------------------- */
(function () {
    'use strict';
    if (document.getElementById('bx-chat-widget')) return; // already mounted

    // ---- skeleton (static markup only — no user data here) ----
    var root = document.createElement('div');
    root.id = 'bx-chat-widget';
    root.innerHTML =
        '<style>' +
        '#bx-chat-widget{font-family:\'Plus Jakarta Sans\',system-ui,-apple-system,sans-serif;z-index:9990;}' +
        'a,b,button,input{font-family:inherit;}' +
        '#bx-chat-fab{position:fixed;right:22px;bottom:22px;width:54px;height:54px;border-radius:50%;' +
        'background:linear-gradient(135deg,#6366f1,#818cf8);color:#fff;border:1px solid rgba(255,255,255,.18);' +
        'display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 10px 30px rgba(99,102,241,.35);' +
        'transition:transform .2s ease,box-shadow .2s ease;}' +
        '#bx-chat-fab:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 14px 36px rgba(99,102,241,.45);}' +
        '#bx-chat-fab svg{pointer-events:none;}' +
        '#bx-chat-panel{position:fixed;right:22px;bottom:90px;width:360px;max-width:calc(100vw - 32px);' +
        'height:480px;max-height:calc(100vh - 130px);background:#18181B;border:1px solid #27272A;border-radius:16px;' +
        'display:none;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);}' +
        '#bx-chat-widget.open #bx-chat-panel{display:flex;}' +
        '#bx-chat-head{display:flex;align-items:baseline;gap:8px;padding:12px 14px;border-bottom:1px solid #27272A;background:#121214;}' +
        '.bx-chat-title{font-weight:700;font-size:14px;color:#FAFAFA;white-space:nowrap;}' +
        '.bx-chat-sub{font-size:10px;color:#71717A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '#bx-chat-close{margin-left:auto;align-self:center;background:none;border:none;color:#A1A1AA;font-size:14px;' +
        'cursor:pointer;padding:4px 8px;border-radius:6px;line-height:1;}' +
        '#bx-chat-close:hover{color:#fff;background:#27272A;}' +
        '#bx-chat-scroll{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}' +
        '.bx-msg{max-width:85%;padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.5;' +
        'white-space:pre-wrap;word-break:break-word;}' +
        '.bx-msg-bot{align-self:flex-start;background:#1C1C20;border:1px solid #27272A;color:#E4E4E7;border-bottom-left-radius:4px;}' +
        '.bx-msg-user{align-self:flex-end;background:linear-gradient(135deg,#6366f1,#818cf8);color:#fff;border-bottom-right-radius:4px;}' +
        '.bx-msg-typing{color:#A1A1AA;font-style:italic;}' +
        '#bx-chat-err{margin:0 14px 2px;padding:8px 10px;border-radius:8px;background:rgba(248,113,113,.12);' +
        'border:1px solid rgba(248,113,113,.3);color:#FCA5A5;font-size:12px;}' +
        '#bx-chat-form{display:flex;gap:8px;padding:12px;border-top:1px solid #27272A;background:#121214;}' +
        '#bx-chat-input{flex:1;min-width:0;background:#18181B;border:1px solid #27272A;border-radius:9px;color:#FAFAFA;' +
        'font-size:13px;padding:9px 12px;outline:none;}' +
        '#bx-chat-input:focus{border-color:#6366f1;}' +
        '#bx-chat-input::placeholder{color:#71717A;}' +
        '#bx-chat-send{background:linear-gradient(135deg,#6366f1,#818cf8);border:none;color:#fff;border-radius:9px;' +
        'width:38px;flex:none;cursor:pointer;font-size:14px;}' +
        '#bx-chat-send:disabled{opacity:.5;cursor:default;}' +
        '@media (max-width:480px){#bx-chat-panel{right:12px;left:12px;width:auto;bottom:84px;height:min(480px,calc(100vh - 120px));}#bx-chat-fab{right:16px;bottom:16px;}}' +
        '</style>' +
        '<button id="bx-chat-fab" aria-label="Open AI test chat" title="Ask the BattlexJournal AI">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>' +
        '<div id="bx-chat-panel" role="dialog" aria-label="BattlexJournal AI test chat" aria-hidden="true">' +
        '<div id="bx-chat-head"><span class="bx-chat-title">BattlexJournal AI</span>' +
        '<span class="bx-chat-sub">test chat · not connected to your journal</span>' +
        '<button id="bx-chat-close" aria-label="Close chat" title="Close">✕</button></div>' +
        '<div id="bx-chat-scroll"></div>' +
        '<div id="bx-chat-err" hidden></div>' +
        '<form id="bx-chat-form" autocomplete="off">' +
        '<input id="bx-chat-input" type="text" maxlength="2000" placeholder="Ask anything…" aria-label="Message">' +
        '<button id="bx-chat-send" type="submit" aria-label="Send">➤</button></form></div>';

    document.body.appendChild(root);

    var fab = root.querySelector('#bx-chat-fab');
    var panel = root.querySelector('#bx-chat-panel');
    var closeBtn = root.querySelector('#bx-chat-close');
    var scroll = root.querySelector('#bx-chat-scroll');
    var errBox = root.querySelector('#bx-chat-err');
    var form = root.querySelector('#bx-chat-form');
    var input = root.querySelector('#bx-chat-input');

    var history = [];              // session-only memory: [{role:'user'|'model', text}]
    var busy = false;

    function appendMsg(kind, text) {
        var div = document.createElement('div');
        div.className = 'bx-msg ' + (kind === 'user' ? 'bx-msg-user' : 'bx-msg-bot');
        div.textContent = text;    // XSS-safe: never innerHTML with chat content
        scroll.appendChild(div);
        scroll.scrollTop = scroll.scrollHeight;
        return div;
    }

    function showErr(text) { errBox.textContent = text; errBox.hidden = false; }
    function hideErr() { errBox.hidden = true; }

    function setOpen(open) {
        root.classList.toggle('open', open);
        panel.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (open) input.focus();
    }

    fab.addEventListener('click', function () { setOpen(!root.classList.contains('open')); });
    closeBtn.addEventListener('click', function () { setOpen(false); });

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var text = input.value.trim();
        if (!text || busy) return;
        busy = true;
        hideErr();
        input.value = '';
        appendMsg('user', text);
        history.push({ role: 'user', text: text });
        var typing = appendMsg('bot', '…');
        typing.className = 'bx-msg bx-msg-bot bx-msg-typing';
        try {
            var res = await fetch('/api/chat-test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text, history: history.slice(-20) })
            });
            var j = null;
            try { j = await res.json(); } catch (e2) { /* non-JSON error body */ }
            if (res.status === 429) {
                showErr(j && j.error ? j.error : 'Chat limit reached — try again later.');
            } else if (res.status === 503) {
                showErr(j && j.error ? j.error : 'AI chat is not configured on this server yet.');
            } else if (!res.ok) {
                showErr(j && j.error ? j.error : 'Something went wrong — try again.');
            } else if (j && j.reply) {
                history.push({ role: 'model', text: j.reply });
                typing.remove();
                appendMsg('bot', j.reply);
            }
        } catch (err) {
            showErr('Network error — check your connection and try again.');
        } finally {
            busy = false;
            typing.remove();       // already removed on success; no-op otherwise
            input.focus();
        }
    });
})();