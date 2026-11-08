/* =============================================================================
 * public/app.js — 学生前端（服务端版）
 * -----------------------------------------------------------------------------
 * 这个文件里**没有**任何数学代码、解题代码、提示话术或答案。
 * 它只做四件事：收集输入 → 调 /api/* → 渲染服务端返回的消息 → 展示会话摘要。
 *
 * 答案保护的关键就在这里：前端根本没有能力算出答案，
 * 因为 engine/mathcore.js 与 engine/tutor.js 不在 public/ 目录下，
 * 服务端也不会把它们作为静态文件下发。
 *
 * 隐私：不采集姓名、学校、设备信息，无埋点。
 *       仅在 localStorage 存一份「上次做到哪一步」的摘要，可一键清除。
 * ========================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'no-answer-tutor:last-session';
  var formatMathForDisplay = window.formatTutorMath || function (value) { return String(value == null ? '' : value); };
  var sessionId = null;
  var busy = false;
  var aiModelName = '';   // 由 /api/health 与 /api/start 缓存，供逐轮徽标 tooltip 使用

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    panelSetup: $('panel-setup'), panelChat: $('panel-chat'), panelEnd: $('panel-end'),
    inProblem: $('in-problem'), inAttempt: $('in-attempt'), inReply: $('in-reply'),
    btnStart: $('btn-start'), btnDontKnow: $('btn-dontknow'), btnSend: $('btn-send'),
    btnVoice: $('btn-voice'), voiceStatus: $('voice-status'),
    btnExitTop: $('btn-exit-top'), btnRestart: $('btn-restart'), btnAgain: $('btn-again'),
    form: $('input-form'), transcript: $('transcript'),
    problemText: $('chat-problem-text'), progress: $('chat-progress'),
    endTitle: $('end-title'), endBody: $('end-body'),
    quickRow: $('quick-row'),
    linkClear: $('link-clear'), aiBadge: $('ai-badge'),
    connError: $('conn-error'), connErrorDetail: $('conn-error-detail'),
    thinking: $('thinking'), thinkingLabel: $('thinking-label'), problemError: $('problem-error'), replyError: $('reply-error'),
    btnHelp: $('btn-help'), helpPanel: $('help-panel')
  };

  /* ---------- 输入校验反馈 ----------
   * 只闪一下红框是不够的：学生可能根本没在看输入框。所以除了边框，
   * 还要留一条**不会自己消失**的文字，直到学生重新输入为止。 */

  function showFieldError(input, msgEl, text) {
    input.style.borderColor = 'var(--danger)';
    if (msgEl) { msgEl.textContent = text; msgEl.hidden = false; }
    input.focus();
  }
  function clearFieldError(input, msgEl) {
    input.style.borderColor = '';
    if (msgEl) { msgEl.textContent = ''; msgEl.hidden = true; }
  }

  /* ---------- 对话期视口锁定 ----------
   * 进入辅导后给 body 加 .in-chat：把 body 固定为 100vh 且禁止整页滚动，
   * 只让 transcript 内部滚动。这样顶栏与「当前题目」条在长对话里始终可见，
   * 输入区也不会被挤到视口外（手机上尤其重要）。
   * 离开对话（结束面板 / 回到首页）时移除，恢复整页正常滚动。 */
  function setChatLayout(on) {
    document.body.classList.toggle('in-chat', !!on);
  }

  /* ---------- 网络层 ---------- */

  // The access password is kept only in memory for this page, never in URLs or storage.
  var remoteAuthorization = '';
  function remoteFetch(url, opts, allowPrompt) {
    var headers = Object.assign({}, opts.headers || {});
    if (remoteAuthorization) headers.Authorization = remoteAuthorization;
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function (response) {
      if (response.status !== 401 || !window.TUTOR_API_ORIGIN || !allowPrompt) return response;
      remoteAuthorization = '';
      var password = window.prompt('请输入辅导服务访问密码');
      if (!password) return response;
      if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('访问密码请使用英文、数字或英文符号');
      remoteAuthorization = 'Basic ' + btoa('team:' + password);
      return remoteFetch(url, opts, false);
    });
  }

  function apiUrl(pathname) {
    var origin = String(window.TUTOR_API_ORIGIN || '').trim();
    if (!origin) return pathname;
    var parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('辅导服务地址配置无效');
    return parsed.origin + pathname;
  }

  function api(pathname, body) {
    var opts = body === undefined
      ? { method: 'GET', headers: { 'Accept': 'application/json' } }
      : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      };
    var url;
    try { url = apiUrl(pathname); } catch (err) { return Promise.reject(err); }
    return remoteFetch(url, opts, true).then(function (r) {
      return r.json().catch(function () { return { error: 'bad_response' }; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || j.error || ('HTTP ' + r.status)); e.payload = j; throw e; }
        return j;
      });
    });
  }

  function showConnError(detail) {
    el.connErrorDetail.textContent = detail ? ('（' + detail + '）') : '';
    el.connError.hidden = false;
  }
  function hideConnError() { el.connError.hidden = true; }

  /* ---------- AI 状态徽标：对学生诚实 ----------
    *
    * 四种状态，不能只有两种，也不能有三种：
    *   ai-on    密钥就绪 **且已经成功调用过** → 模型确实在参与理解
    *   ai-idle  密钥就绪但一次都没成功调用过 → 连通性还没验证。
    *            这时说「已启用」是假话：密钥可能填错、模型可能没开通、
    *            网络可能不通，全都要等第一次真实调用才知道。
    *   ai-warn  密钥就绪但最近一次调用失败 → 事实上已降级为规则引擎。
    *            这种情况必须显示成「调用失败」，否则就是伪装成调用成功。
    *   ai-off   根本没配密钥 → 一直是规则引擎
    *
    * tooltip 里一律用服务端给的 detail（人话），不把 no_api_key / http_5xx
    * 这类内部原因码直接甩给学生；原因码只在「需要转告老师/家长去查」时附上。
    */
  function renderAiBadge(ai) {
    if (!ai) { el.aiBadge.textContent = 'AI 状态未知'; el.aiBadge.className = 'ai-badge ai-off'; return; }
    if (!ai.available) { el.aiBadge.textContent = 'AI 未配置'; el.aiBadge.className = 'ai-badge ai-off'; el.aiBadge.title = '请联系管理者配置模型。'; return; }
    if (ai.degraded) { el.aiBadge.textContent = 'AI 暂时不可用'; el.aiBadge.className = 'ai-badge ai-warn'; el.aiBadge.title = '模型调用失败，请稍后重试。'; return; }
    el.aiBadge.textContent = ai.verified ? 'AI 已连接' : 'AI 待验证';
    el.aiBadge.className = 'ai-badge ' + (ai.verified ? 'ai-on' : 'ai-idle');
    el.aiBadge.title = '题目和对话由 AI 处理，数学判断可能出错。';
  }

  /**
   * 本轮模型调用失败时，在对话流里插一条系统说明。
   * 需求 7：不伪装成功。学生应该知道这一句老师「没听懂」是因为系统故障，
   * 而不是因为他自己表达得不好——这对挫败感很重的学生尤其重要。
   * 只在真的失败时插一次，且用 uncertain 样式与正常教学话术区分开。
   */
  var lastAiNoteShown = '';
  function renderAiNote(r) {
    var note = r && r.ai && r.ai.failed ? (r.ai.aiNote || '') : '';
    if (!note || note === lastAiNoteShown) return;
    lastAiNoteShown = note;
    renderMsg({ role: 'ai', text: '（系统提示：' + note + '）', kind: 'uncertain' });
  }

  function loadHealth() {
    return api('/api/health').then(function (h) {
      if (h.ai && h.ai.model) aiModelName = h.ai.model;
      renderAiBadge(h.ai);
      hideConnError();
    }).catch(function (err) {
      renderAiBadge(null);
      showConnError(err.message);
    });
  }

  /* ---------- 渲染 ---------- */

  function renderMsg(m) {
    // 首次渲染时清掉空态占位（如果有）
    var emptyEl = el.transcript.querySelector('.transcript-empty');
    if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);

    // 「最新一条老师消息 = 当前需要学生思考的问题」——用 msg-current 类突出。
    // 每次渲染新消息前先把上一条 AI 的 msg-current 摘掉，保证只有一条被高亮。
    var prevCurrent = el.transcript.querySelector('.msg-ai.msg-current');
    if (prevCurrent) prevCurrent.classList.remove('msg-current');

    var div = document.createElement('div');
    var kind = m.kind || 'normal';
    div.className = 'msg msg-' + (m.role === 'student' ? 'student' : 'ai') +
      (m.role === 'ai' && kind !== 'normal' ? ' msg-' + kind : '');
    // 只有普通老师消息才作为「当前问题」高亮；crisis/closing/exit/note 等
    // 状态消息本身就有各自的强视觉，不需要再叠加高亮，否则会抢焦点。
    if (m.role === 'ai' && kind === 'normal') div.classList.add('msg-current');
    var role = document.createElement('span');
    role.className = 'msg-role';
    role.textContent = m.role === 'student' ? '你' : '老师';
    div.appendChild(role);
    div.appendChild(document.createTextNode(m.role === 'ai' ? formatMathForDisplay(m.text) : m.text));
    el.transcript.appendChild(div);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function renderAll(msgs) {
    for (var i = 0; i < (msgs || []).length; i++) renderMsg(msgs[i]);
  }

  function renderProgress(state) {
    if (!state || !state.progress) { el.progress.textContent = ''; return; }
    var p = state.progress;
    // 通用 AI 引导模式没有固定站点序列（stepsTotal=0），不能显示「步骤 0/0」，
    // 改成显示模式与题型，避免学生误以为系统坏了。
    if (state.mode === 'general' || !p.stepsTotal) {
      var glabel = state.phase === 'exit' ? '已退出'
        : state.phase === 'crisis' ? '已停止'
          : state.phase === 'boundary' ? '这道题没法辅导'
            : 'AI 辅导中';
      el.progress.textContent = glabel + (p.focusStage ? ' · 题型：' + p.focusStage : '');
      return;
    }
    var label = p.completed ? '已完成，正在复盘'
      : (state.phase === 'exit' ? '已退出'
        : (state.phase === 'closing' ? '今天先到这里'
          : '走到：' + (p.focusStage || '—')));
    el.progress.textContent = '步骤 ' + Math.min(p.stepsDone, p.stepsTotal) + '/' + p.stepsTotal + ' · ' + label;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- 结束面板 ---------- */

  function showEnd(title, s) {
    el.endTitle.textContent = title;
    var html = '<dl class="end-grid"><div class="end-item"><dt>题目</dt><dd>' + esc(s.problem || '—') + '</dd></div>' +
      '<div class="end-item"><dt>当前卡点（AI 判断）</dt><dd>' + esc(s.blocker_step || '尚未明确') + '</dd></div></dl>';
    if (s.check_requested) html += '<p class="field-hint">你尝试了自我检查；是否正确请结合你的验算和老师讲解判断。</p>';
    html += '<div class="end-help" style="white-space:pre-wrap">' + esc(formatMathForDisplay(s.review || '复盘暂时没有生成。可以回看上面的对话，或向老师求助。')) + '</div>';
    html += '<p class="field-hint">AI 的判断和练习可能有误，请结合课堂内容核对。</p>';
    el.endBody.innerHTML = html; el.panelEnd.hidden = false; saveLocal(s);
  }

  /* ---------- 本地记录（仅摘要） ---------- */

  function saveLocal(summary) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        at: new Date().toISOString(),
        problem: summary.problem,
        completed: summary.completed,
        blocker_step: summary.blocker_step,
        max_hint_level: summary.max_hint_level
      }));
    } catch (e) { /* 隐私模式或禁用存储时静默跳过 */ }
  }

  function loadLocal() {
    try {
      var existing = el.panelSetup.querySelector('.local-record');
      if (existing) existing.remove();
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var rec = JSON.parse(raw);
      if (!rec || !rec.problem) return;
      var p = document.createElement('p');
      p.className = 'local-record';
      p.textContent = '上次记录：' + rec.problem +
        (rec.completed ? '（已自己做完）' : '（卡在' + (rec.blocker_step || '某一步') + '）') +
        ' · ' + String(rec.at).slice(0, 10);
      // 挂到首页卡片末尾，而不是 panel-setup 末尾——panel-setup 现在是
      // hero + card 两段结构，追加到 panel-setup 会让记录跑到卡片外面。
      var card = el.panelSetup.querySelector('.setup-card');
      (card || el.panelSetup).appendChild(p);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 语音输入（Web Speech API） ----------
   *
   * 设计取舍（写下来避免下次接手误改）：
   * 1. **只用浏览器原生能力**（SpeechRecognition / webkitSpeechRecognition）。
   *    不引第三方 SDK、不加网络请求，前端保持零依赖；识别质量与语言支持
   *    完全取决于浏览器，我们**不假装**它能保证数学符号准确。
   * 2. **追加不覆盖**：录音开始前把输入框已有内容存进 baseText，
   *    识别结果始终接在 baseText 之后。学生先写了一半再补说，也不会丢字。
   * 3. **不自动发送**：识别完成后焦点回到输入框，学生必须自己按「发送」。
   *    这条与整个项目「不替学生做决定」的取向一致。
   * 4. **不支持就藏起来**：Firefox 等浏览器没有 SpeechRecognition，
   *    按钮保持 hidden，避免让学生看到一个点了没反应的控件。
   *    支持但失败（无麦克风、被拒权限、离线）时，用文字如实说明，
   *    并建议改用键盘输入——**不重试、不静默、不伪装成功**。
   * 5. **数学场景诚实说明**：帮助面板里明说「数字、字母、数学符号可能被听错，
   *    说完请检查一遍」，不做任何自动「修数学符号」的后处理（那会引入
   *    我们控制不了的错误）。
   */
  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var recognition = null;      // 当前 SpeechRecognition 实例；没有活实例时为 null
  var listening = false;       // 是否处于「浏览器已开始录音」的状态（onstart 之后）
  var voiceStarting = false;   // 已调 start() 但 onstart 还没到（等权限/初始化）
  var voiceBase = '';          // 开始录音前输入框已有的内容（追加基线，不含分隔符）
  var voiceSep = '';           // 基线与识别结果之间的分隔符（仅当真的有识别结果时才拼上）
  var voiceFinal = '';         // 本次录音里已落定的识别结果
  var voiceInterim = '';       // 本次录音里浏览器还在犹豫的中间结果
  var voiceStatusTimer = null; // 「已识别，检查后发送」提示的自动清除定时器

  function setVoiceStatus(text, kind) {
    if (!el.voiceStatus) return;
    if (voiceStatusTimer) { clearTimeout(voiceStatusTimer); voiceStatusTimer = null; }
    if (!text) {
      el.voiceStatus.hidden = true;
      el.voiceStatus.textContent = '';
      el.voiceStatus.classList.remove('is-error');
      el.voiceStatus.classList.remove('is-ok');
      return;
    }
    el.voiceStatus.hidden = false;
    el.voiceStatus.textContent = text;
    el.voiceStatus.classList.toggle('is-error', kind === 'error');
    el.voiceStatus.classList.toggle('is-ok', kind === 'ok');
  }

  function updateVoiceButton() {
    if (!el.btnVoice) return;
    // 浏览器不支持时按钮永远保持隐藏，不参与后续状态切换
    if (!SpeechRecognitionCtor) { el.btnVoice.hidden = true; return; }
    el.btnVoice.hidden = false;
    /* active = 已开始录音 或 正在等权限/初始化。
     * 把「等权限」也算作 active，是为了让第二次点击走 stopVoice()，
     * 而不是又 new 一个实例把前一个变成孤儿（浏览器实测抓到的连点缺陷）。 */
    var active = listening || voiceStarting;
    el.btnVoice.setAttribute('aria-pressed', active ? 'true' : 'false');
    el.btnVoice.setAttribute('aria-label', active ? '停止语音输入' : '开始语音输入');
    el.btnVoice.title = active
      ? '正在听，点击停止。识别到的文字会填进输入框，需要你自己点「发送」。'
      : '点击开始用说的，再点一次停止。识别到的文字会填进输入框，不会自动发送。';
    // 会话已结束（inReply 被禁用）时，语音按钮也一并禁用
    el.btnVoice.disabled = !!el.inReply.disabled;
  }

  function paintVoicePreview() {
    // 让学生实时看到浏览器听到的内容；光标位置在末尾，方便继续说或立刻改。
    // 只有真的识别到内容时才拼上分隔符；说了半天没识别出字时，
    // 输入框保持原样（不留一个多余的空格尾巴）。
    var appended = voiceFinal + voiceInterim;
    var combined = appended ? (voiceBase + voiceSep + appended) : voiceBase;
    if (el.inReply.value !== combined) el.inReply.value = combined;
  }

  function startVoice() {
    /* 只要还有一个活实例（starting / listening / stopping 中）就不再 new。
     * 连点时第二次点击会经 toggleVoice 走 stopVoice()，而不是产生孤儿实例。 */
    if (!SpeechRecognitionCtor || recognition) return;
    if (el.inReply.disabled) return; // 会话已结束，不允许录音
    try {
      recognition = new SpeechRecognitionCtor();
    } catch (err) {
      setVoiceStatus('浏览器语音识别启动失败，请改用键盘输入。', 'error');
      recognition = null;
      return;
    }
    recognition.lang = 'zh-CN';         // 中文普通话
    recognition.continuous = true;      // 允许说多句
    recognition.interimResults = true;  // 边说边显示，学生能立刻发现听错了
    recognition.maxAlternatives = 1;

    voiceBase = el.inReply.value || '';
    // 分隔符只在「真的有识别结果要追加」时才拼上（见 paintVoicePreview）；
    // 基线末尾已是空白时不需要再加。这样没识别出字时输入框保持原样。
    voiceSep = (voiceBase && !/\s$/.test(voiceBase)) ? ' ' : '';
    voiceFinal = '';
    voiceInterim = '';

    recognition.onstart = function () {
      voiceStarting = false;
      listening = true;
      updateVoiceButton();
      setVoiceStatus('正在听，请说话…（说完点一下「语音」停止）');
    };
    recognition.onresult = function (event) {
      var newInterim = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var res = event.results[i];
        var chunk = (res[0] && res[0].transcript) ? res[0].transcript : '';
        if (res.isFinal) voiceFinal += chunk;
        else newInterim += chunk;
      }
      voiceInterim = newInterim;
      paintVoicePreview();
    };
    recognition.onerror = function (event) {
      voiceStarting = false;
      var reason = event && event.error;
      // 学生主动停止时浏览器会先派 'aborted'，随后 onend 会接管，这里不当错误处理
      if (reason === 'aborted') return;
      var msg;
      if (reason === 'not-allowed' || reason === 'service-not-allowed') {
        msg = '浏览器拒绝了麦克风权限。请在地址栏附近允许麦克风后再试，或改用键盘输入。';
      } else if (reason === 'no-speech') {
        msg = '没有听到说话声。检查一下麦克风，或改用键盘输入。';
      } else if (reason === 'audio-capture') {
        msg = '没有找到麦克风。请检查设备连接，或改用键盘输入。';
      } else if (reason === 'network') {
        msg = '浏览器语音识别需要联网，当前网络不通。请改用键盘输入。';
      } else {
        msg = '语音识别出错（' + (reason || '未知原因') + '）。请改用键盘输入。';
      }
      setVoiceStatus(msg, 'error');
    };
    recognition.onend = function () {
      voiceStarting = false;
      listening = false;
      // 学生突然点停止时可能还有 interim 没落地，合并进 final 避免丢字
      if (voiceInterim) { voiceFinal += voiceInterim; voiceInterim = ''; }
      paintVoicePreview();
      updateVoiceButton();
      /* 会话已结束（输入框被禁用）时不再刷新状态文字：
       * 否则会出现「可以再点一次语音重试」但按钮已经灰掉的自相矛盾提示。
       * 也只在没有错误提示时才刷新，避免覆盖 onerror 已经写下的话。 */
      if (!el.inReply.disabled && !el.voiceStatus.classList.contains('is-error')) {
        if (voiceFinal.trim()) {
          setVoiceStatus('已识别，请检查文字（数字和符号可能听错），再点「发送」。', 'ok');
          // 8 秒后自动清除；若学生又开始录下一段，setVoiceStatus 内部会先清 timer
          voiceStatusTimer = setTimeout(function () {
            voiceStatusTimer = null;
            if (!listening) setVoiceStatus('');
          }, 8000);
        } else {
          setVoiceStatus('这次没有识别到内容。可以再点一次「语音」重试，或改用键盘输入。');
        }
      }
      recognition = null;
      // 焦点回到输入框，方便学生直接检查/修改
      if (!el.inReply.disabled) {
        try { el.inReply.focus(); } catch (e) { /* 忽略 */ }
      }
    };

    // 进入「等权限/初始化」态：按钮立刻切到停止态，状态条说明在等什么。
    // 这样第二次点击会走 stopVoice()，而不是又 new 一个实例。
    voiceStarting = true;
    updateVoiceButton();
    setVoiceStatus('正在准备麦克风…（浏览器可能会询问权限，请允许）');

    try {
      recognition.start();
    } catch (err) {
      // 快速连点或浏览器内部状态异常会抛 InvalidStateError
      setVoiceStatus('语音识别没能启动，请稍后再试或改用键盘输入。', 'error');
      recognition = null;
      listening = false;
      voiceStarting = false;
      updateVoiceButton();
    }
  }

  function stopVoice() {
    // 没有活实例时只需把状态位复位（例如会话结束/换题时兜底调用）
    if (!recognition) { listening = false; voiceStarting = false; return; }
    // stop() 后 onend 会把 recognition 置 null 并复位状态位，这里不提前置空，
    // 否则连点「停止」会以为没有实例而跳过，留下一个收不掉的录音。
    try { recognition.stop(); } catch (err) { /* 忽略，onend 会兜底 */ }
  }

  function toggleVoice() {
    // 有活实例（含等权限中）就停止，没有才开始——保证同时只有一个实例
    if (recognition) stopVoice();
    else startVoice();
  }

  /* ---------- 流程控制 ---------- */

  var busyTimer = null;
  function setBusy(on) {
    busy = on;
    if (busyTimer !== null) { clearTimeout(busyTimer); busyTimer = null; }
    el.btnStart.disabled = on;
    el.btnDontKnow.disabled = on;
    el.btnStart.textContent = on && !el.panelSetup.hidden ? '正在准备辅导…' : '开始一起思考';
    el.panelSetup.setAttribute('aria-busy', on && !el.panelSetup.hidden ? 'true' : 'false');
    el.thinking.hidden = !on;
    el.thinkingLabel.textContent = '老师正在看';
    if (on) busyTimer = setTimeout(function () {
      if (!busy) return;
      if (!el.panelSetup.hidden) el.btnStart.textContent = '仍在准备，请稍候…';
      else el.thinkingLabel.textContent = '还在思考，请稍候…';
    }, 8000);
    el.btnSend.disabled = on || el.inReply.disabled;
    el.btnExitTop.disabled = on || el.inReply.disabled;
    var quickButtons = el.quickRow.querySelectorAll('button');
    for (var i = 0; i < quickButtons.length; i++) quickButtons[i].disabled = on || el.inReply.disabled;
  }

  function applyResponse(r) {
    // /api/message 的 ai 字段只带 available/degraded/verified/statusReason（不带 model），
    // 与缓存下来的 model 合并后再刷新徽标，避免 tooltip 出现 undefined。
    // ★ 用 statusReason 而不是 reason：reason 是**这一轮**的结果
    //   （可能是 'ok' 或 'not_needed'），拿它当故障码显示会误导。
    if (r.ai) {
      if (r.ai.model) aiModelName = r.ai.model;
      renderAiBadge({
        available: r.ai.available,
        degraded: r.ai.degraded,
        verified: r.ai.verified,
        reason: r.ai.statusReason,
        detail: r.ai.detail,
        model: aiModelName
      });
    }
    renderAll(r.messages);
    renderAiNote(r);
    renderProgress(r.state);
    if (r.state && r.state.problem) el.problemText.textContent = r.state.problem;
    syncPhase(r);
    if (r.summary) {
      var title = r.state.phase === 'exit' ? '本次会话记录（已退出）'
        : r.state.phase === 'crisis' ? '本次会话已停止'
          : '本次会话记录（已完成）';
      showEnd(title, r.summary);
    }
  }

  function syncPhase(r) {
    var ph = r.state ? r.state.phase : '';
    var ended = r.ended === true || ['exit', 'crisis', 'done', 'boundary'].indexOf(ph) >= 0;
    el.inReply.disabled = ended;
    el.btnSend.disabled = ended;
    el.quickRow.style.opacity = ended ? '.4' : '1';
    var chips = el.quickRow.querySelectorAll('button');
    for (var i = 0; i < chips.length; i++) chips[i].disabled = ended;
    /* 会话结束时若还在录音，必须停下来：
     * 否则会往一个已经不能再发消息的输入框里继续追加文字，
     * 学生看到「语音识别还在跑但发不出去」会以为系统坏了。
     * 同时清掉状态文字：onend 里也有 !inReply.disabled 守卫，不会再把
     * 「可以再点一次重试」这类提示写回一个已灰掉的按钮旁边。 */
    if (ended) { stopVoice(); setVoiceStatus(''); }
    updateVoiceButton();
  }

  function beginSession(problem, attempt, dontKnow) {
    problem = String(problem || '').trim();
    if (!problem) {
      showFieldError(el.inProblem, el.problemError,
        '题目还是空的。请先输入一道数学题，再点「开始」。');
      return;
    }
    if (busy) return;
    /* 同 send()：长度问题必须在前端说清楚，不能让它变成「连不上服务端」。 */
    if (problem.length > 1000 || String(attempt || '').length > 4000) {
      showFieldError(el.inProblem, el.problemError,
        '输入太长了（题目上限 1000 字，已写步骤上限 4000 字）。' +
        '一道题通常一两行——你是不是把整页题目都贴进来了？');
      return;
    }
    clearFieldError(el.inProblem, el.problemError);
    setBusy(true);
    // 先清空上一轮的题目与进度：boundary / clarify 这类会话的 state 里没有
    // problem 字段，如果不先重置，顶栏会继续显示**上一道题**，等于在骗学生。
    el.problemText.textContent = '—';
    el.progress.textContent = '';
    api('/api/start', { problem: problem, attempt: String(attempt || ''), dontKnow: !!dontKnow })
      .then(function (r) {
        hideConnError();
        sessionId = r.sessionId;
        if (r.ai) { if (r.ai.model) aiModelName = r.ai.model; renderAiBadge(r.ai); }
        el.transcript.innerHTML = '';
        el.panelSetup.hidden = true;
        el.panelEnd.hidden = true;
        el.panelChat.hidden = false;
        setChatLayout(true);
        el.btnExitTop.hidden = false;
        el.btnRestart.hidden = false;
        el.inReply.value = '';
        el.inReply.disabled = false;
        renderAll(r.messages);
        renderProgress(r.state);
        if (r.state && r.state.problem) el.problemText.textContent = r.state.problem;
        /* 超纲/病态题目在 start 阶段就直接进入 boundary，会话已经结束。
         * 不调这一步的话输入框还是可用的，学生能再发一条消息才看到它变灰——
         * 界面状态和实际会话状态差了一轮。 */
        syncPhase(r);
        /* 新会话开始时把语音状态清干净：上一轮遗留的「正在听」/错误提示
         * 不该跟着进入这一题；若正在录音也停掉，避免把内容写进新会话的输入框。 */
        stopVoice();
        setVoiceStatus('');
        updateVoiceButton();
        el.inReply.focus();
      })
      .catch(function (err) {
        // 开始新会话时被频率限制：如实说「稍等再试」，不要误报成「连不上服务端」。
        if (err.payload && err.payload.error === 'rate_limited') {
          showFieldError(el.inProblem, el.problemError,
            err.payload.message || '你发得有点太快了，请稍等一分钟再点「开始」。');
        } else if (err.payload && (err.payload.error === 'body_too_large' || err.payload.error === 'too_long' || err.payload.error === 'empty_problem')) {
          showFieldError(el.inProblem, el.problemError, err.payload.message || '输入内容过长，请缩短后重试。');
        } else {
          showConnError(err.message);
        }
      })
      .finally(function () { setBusy(false); });
  }

  function send(text, action) {
    if (!sessionId || busy) return;
    text = String(text == null ? '' : text);
    if (!text.trim()) {
      showFieldError(el.inReply, el.replyError,
        '你还没有写内容。写下你的想法，或者点下面的「给点提示」。');
      return;
    }
    clearFieldError(el.inReply, el.replyError);
    /* 长度必须在前端就拦住。服务端的上限是 2000 字，超了会回 400，
     * 而 400 会走到 showConnError —— 学生看到的是「连不上服务端」，
     * 可服务端明明活着，真实原因是「你贴进来的内容太长」。
     * 把输入问题说成连接故障，学生会去反复刷新而不是删掉多余内容。 */
    if (text.length > 2000) {
      showFieldError(el.inReply, el.replyError,
        '这段太长了（' + text.length + ' 字，上限 2000）。一次只写一步就好——' +
        '把你现在写的那一行式子打给我。');
      return;
    }
    renderMsg({ role: 'student', text: text });
    if (!action) el.inReply.value = '';
    setBusy(true);
    /* action（hint/explain/understood）来自快捷按钮，告诉服务端这是哪一种交互意图，
     * 而不是把按钮文字当普通聊天内容去猜。普通输入框发送时 action 为 undefined。 */
    var payload = { sessionId: sessionId, text: text };
    if (action) payload.action = action;
    api('/api/message', payload)
      .then(function (r) { hideConnError(); applyResponse(r); })
      .catch(function (err) {
        // Keep an unsent typed message available for editing/retry after a
        // request failure. Never overwrite a new draft typed while waiting.
        if (!action && !el.inReply.value && !(err.payload && err.payload.error === 'session_not_found')) {
          el.inReply.value = text;
        }
        if (err.payload && err.payload.error === 'session_not_found') {
          renderMsg({ role: 'ai', text: err.payload.message || '这次会话已经过期了，请点「换一道题」重新开始。', kind: 'uncertain' });
          el.inReply.disabled = true; el.btnSend.disabled = true;
          sessionId = null;
        } else if (err.payload && err.payload.error === 'session_busy') {
          renderMsg({ role: 'ai', text: err.payload.message || '上一条消息还在处理中，请稍候。', kind: 'uncertain' });
        } else if (err.payload && err.payload.error === 'rate_limited') {
          // 频率限制不是「连不上服务端」——服务端活得好好的，是发得太快了。
          // 必须如实说成「稍等再试」，否则学生会去反复刷新而不是慢下来。
          renderMsg({ role: 'ai', text: err.payload.message || '你发得有点太快了，请稍等一分钟再试。', kind: 'uncertain' });
        } else if (err.payload && err.payload.error === 'body_too_large') {
          renderMsg({ role: 'ai', text: '这段内容太长了，请缩短后重试。', kind: 'uncertain' });
        } else {
          showConnError(err.message);
        }
      })
      .finally(function () { setBusy(false); });
  }

  function restart() {
    if (sessionId) {
      // 让服务端立刻丢掉这个会话（含答案与骨架），不依赖 TTL
      try {
        remoteFetch(apiUrl('/api/session'), {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId })
        }, false).catch(function () { /* 忽略 */ });
      } catch (err) { /* Invalid remote configuration: still return to setup. */ }
    }
    sessionId = null;
    el.panelChat.hidden = true;
    el.panelEnd.hidden = true;
    el.panelSetup.hidden = false;
    setChatLayout(false);
    el.btnExitTop.hidden = true;
    el.btnRestart.hidden = true;
    el.inAttempt.value = '';
    el.inProblem.value = '';
    el.inReply.disabled = false;
    loadLocal();
    clearFieldError(el.inProblem, el.problemError);
    clearFieldError(el.inReply, el.replyError);
    /* 换一道题时把语音状态一并复位：上一轮遗留的「正在听」/错误提示
     * 不应该跟着学生进入下一题。 */
    stopVoice();
    setVoiceStatus('');
    updateVoiceButton();
    el.inProblem.focus();
  }

  /* ---------- 事件绑定 ---------- */

  // 学生一开始重新输入，就撤掉错误提示——不要让红字一直挂在那里
  el.inProblem.addEventListener('input', function () { clearFieldError(el.inProblem, el.problemError); });
  el.inReply.addEventListener('input', function () { clearFieldError(el.inReply, el.replyError); });

  el.btnStart.addEventListener('click', function () {
    beginSession(el.inProblem.value, el.inAttempt.value, false);
  });
  el.btnDontKnow.addEventListener('click', function () {
    beginSession(el.inProblem.value, el.inAttempt.value, true);
  });
  el.form.addEventListener('submit', function (e) { e.preventDefault(); send(el.inReply.value); });
  el.inReply.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(el.inReply.value); }
  });
  el.quickRow.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-action]');
    if (b) send(b.getAttribute('data-label') || b.textContent, b.getAttribute('data-action'));
  });
  el.btnExitTop.addEventListener('click', function () { send('结束并复盘', 'review'); });
  el.btnRestart.addEventListener('click', restart);
  el.btnAgain.addEventListener('click', restart);
  el.btnHelp.addEventListener('click', function () {
    el.helpPanel.hidden = !el.helpPanel.hidden;
    // 同步 aria-expanded，读屏软件与视觉状态一致
    el.btnHelp.setAttribute('aria-expanded', el.helpPanel.hidden ? 'false' : 'true');
  });
  /* 语音按钮：只在浏览器支持时才绑事件；不支持时按钮永远 hidden，
   * 学生看不到也就点不到，避免「点了没反应」的困惑。 */
  if (SpeechRecognitionCtor && el.btnVoice) {
    el.btnVoice.addEventListener('click', toggleVoice);
  }
  el.linkClear.addEventListener('click', function (e) {
    e.preventDefault();
    try {
      localStorage.removeItem(STORE_KEY);
      var record = el.panelSetup.querySelector('.local-record');
      if (record) record.remove();
      el.linkClear.textContent = '已清除';
    } catch (err) {
      el.linkClear.textContent = '清除失败，请检查浏览器存储设置';
    }
    setTimeout(function () { el.linkClear.textContent = '清除本地记录'; }, 1500);
  });

  /* ---------- 启动 ---------- */

  loadLocal();
  loadHealth();
  /* 初始化语音按钮：支持则显示（初始为非录音态、可用），不支持则保持隐藏。
   * 必须在 loadHealth 之外单独调，因为按钮可见性与 AI 状态无关。 */
  updateVoiceButton();
  el.inProblem.focus();
})();
