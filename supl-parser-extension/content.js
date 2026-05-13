// content.js — Supl.biz Parser v2
// Работает на любой странице supl.biz
// • Находит карточки .a_RU8Dmprq
// • Для каждой компании строит URL /about/ и забирает расширенные данные через fetch
// • Умная капча-пауза: обратный таймер + кнопка «готово»
// • Выживает после перезагрузки страницы

(async function () {
  'use strict';
  if (document.getElementById('spl-panel')) return;

  // ─────────── ПАНЕЛЬ ───────────
  const panel = document.createElement('div');
  panel.id = 'spl-panel';
  panel.innerHTML = `
    <div id="spl-header">
      <div id="spl-title">
        <span id="spl-title-dot"></span>
        Supl Parser
      </div>
      <span id="spl-minimize" title="Свернуть">−</span>
    </div>
    <div id="spl-body">
      <div id="spl-status">Готов. Найдите список поставщиков.</div>
      <div id="spl-captcha-timer">
        ⏳ Ожидание снятия блокировки…<br>
        <b id="spl-timer-count">—</b>
        <span id="spl-timer-label" style="font-size:10px;color:#b07a00">сек. Затем автоперезагрузка</span>
      </div>
      <div id="spl-progress-wrap"><div id="spl-progress-bar"></div></div>
      <div id="spl-progress-label"></div>

      <div class="spl-row" id="spl-delay-row">
        <span class="spl-row-label">Пауза (сек)</span>
        <input class="spl-num" id="spl-delay-min" type="number" min="0" step="0.5" value="2">
        <span style="text-align:center;color:#444">—</span>
        <input class="spl-num" id="spl-delay-max" type="number" min="0" step="0.5" value="5">
      </div>
      <div class="spl-row" id="spl-concur-row">
        <span class="spl-row-label">Потоков</span>
        <input class="spl-num" id="spl-concurrency" type="number" min="1" max="8" step="1" value="2">
      </div>
      <div class="spl-row" id="spl-retries-row">
        <span class="spl-row-label">Ретраев при блок.</span>
        <input class="spl-num" id="spl-retries" type="number" min="1" max="10" step="1" value="3">
      </div>
      <div class="spl-sep"></div>
      <div class="spl-row" id="spl-cwait-row">
        <span class="spl-row-label">Ждать при капче (сек)</span>
        <input class="spl-num" id="spl-cwait-min" type="number" min="5" step="1" value="30">
        <span style="text-align:center;color:#444">—</span>
        <input class="spl-num" id="spl-cwait-max" type="number" min="5" step="1" value="60">
      </div>
      <div class="spl-row" id="spl-auto-row">
        <label>
          <input id="spl-auto-reload" type="checkbox" checked>
          Авто-перезагрузка при блокировке
        </label>
      </div>
      <div class="spl-sep"></div>
      <div id="spl-btn-row">
        <button id="spl-btn-start">▶ Запустить</button>
        <button id="spl-btn-stop" disabled>■ Стоп</button>
      </div>
      <button id="spl-btn-captcha">✔ Капча пройдена — продолжить</button>
    </div>
  `;
  document.body.appendChild(panel);

  // ─────────── ЭЛЕМЕНТЫ ───────────
  const $ = (id) => document.getElementById(id);
  const statusEl    = $('spl-status');
  const dot         = $('spl-title-dot');
  const progressW   = $('spl-progress-wrap');
  const progressB   = $('spl-progress-bar');
  const progressL   = $('spl-progress-label');
  const captchaBox  = $('spl-captcha-timer');
  const timerCount  = $('spl-timer-count');
  const timerLabel  = $('spl-timer-label');
  const btnStart    = $('spl-btn-start');
  const btnStop     = $('spl-btn-stop');
  const btnCaptcha  = $('spl-btn-captcha');
  const delayMinEl  = $('spl-delay-min');
  const delayMaxEl  = $('spl-delay-max');
  const concurEl    = $('spl-concurrency');
  const retriesEl   = $('spl-retries');
  const cwaitMinEl  = $('spl-cwait-min');
  const cwaitMaxEl  = $('spl-cwait-max');
  const autoEl      = $('spl-auto-reload');
  const body        = $('spl-body');
  const minimize    = $('spl-minimize');
  const header      = $('spl-header');

  // ─────────── СВОРАЧИВАНИЕ ───────────
  let minimized = false;
  minimize.addEventListener('click', () => {
    minimized = !minimized;
    panel.classList.toggle('spl-minimized', minimized);
    minimize.textContent = minimized ? '+' : '−';
  });

  // ─────────── ПЕРЕТАСКИВАНИЕ ───────────
  let dragging = false, ox = 0, oy = 0;
  header.addEventListener('mousedown', (e) => {
    if (e.target === minimize) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${e.clientX - ox}px`;
    panel.style.top  = `${e.clientY - oy}px`;
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // ─────────── СОСТОЯНИЕ ───────────
  const STATE_KEY    = 'supl-parser-state-v2';
  const SETTINGS_KEY = 'supl-parser-settings-v2';

  let aborted      = false;
  let running      = false;
  let blockPromise = null;
  let blockResolve = null;
  let captchaTimerInterval = null;

  // ─────────── НАСТРОЙКИ ───────────
  function readSettings() {
    const dMin  = Math.max(0, +delayMinEl.value  || 2);
    const dMax  = Math.max(0, +delayMaxEl.value  || 5);
    const cMin  = Math.max(5, +cwaitMinEl.value  || 30);
    const cMax  = Math.max(5, +cwaitMaxEl.value  || 60);
    return {
      delayMin:      Math.min(dMin, dMax),
      delayMax:      Math.max(dMin, dMax),
      concurrency:   Math.min(8, Math.max(1, parseInt(concurEl.value) || 2)),
      maxRetries:    Math.min(10, Math.max(1, parseInt(retriesEl.value) || 3)),
      captchaWaitMin: Math.min(cMin, cMax),
      captchaWaitMax: Math.max(cMin, cMax),
      autoReload:    autoEl.checked,
    };
  }

  async function saveSettings() {
    await chrome.storage.local.set({ [SETTINGS_KEY]: readSettings() });
  }

  async function loadSettings() {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    const s = r[SETTINGS_KEY];
    if (!s) return;
    delayMinEl.value  = s.delayMin  ?? 2;
    delayMaxEl.value  = s.delayMax  ?? 5;
    concurEl.value    = s.concurrency ?? 2;
    retriesEl.value   = s.maxRetries  ?? 3;
    cwaitMinEl.value  = s.captchaWaitMin ?? 30;
    cwaitMaxEl.value  = s.captchaWaitMax ?? 60;
    autoEl.checked    = s.autoReload ?? true;
  }

  // ─────────── STATE PERSIST ───────────
  async function saveState(state) {
    await chrome.storage.local.set({
      [STATE_KEY]: { ...state, url: location.href },
    });
  }
  async function loadState() {
    const r = await chrome.storage.local.get(STATE_KEY);
    return r[STATE_KEY] || null;
  }
  async function clearState() {
    await chrome.storage.local.remove(STATE_KEY);
  }
  function isSamePage(state) {
    return state && Array.isArray(state.data) && state.url === location.href;
  }

  // ─────────── UI HELPERS ───────────
  function setStatus(msg, cls = '') {
    statusEl.textContent = msg;
    statusEl.className = cls;
  }
  function setDot(state) {
    dot.className = state ? state : '';
  }
  function setProgress(cur, total) {
    const pct = total ? Math.round(cur / total * 100) : 0;
    progressW.style.display = 'block';
    progressL.style.display = 'block';
    progressB.style.width = pct + '%';
    progressL.textContent = `${cur} / ${total} (${pct}%)`;
  }
  function resetProgress() {
    progressW.style.display = 'none';
    progressL.style.display = 'none';
    progressB.style.width = '0%';
  }
  function setRunning(state) {
    running = state;
    btnStart.disabled = state;
    btnStop.disabled  = !state;
    setDot(state ? 'running' : '');
  }

  // ─────────── УТИЛИТЫ ───────────
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const norm  = (v) => String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  function randDelay() {
    const { delayMin, delayMax } = readSettings();
    return Math.round((delayMin + Math.random() * (delayMax - delayMin)) * 1000);
  }
  function randCaptchaWait() {
    const { captchaWaitMin, captchaWaitMax } = readSettings();
    return Math.round((captchaWaitMin + Math.random() * (captchaWaitMax - captchaWaitMin)) * 1000);
  }

  // ─────────── ДЕТЕКЦИЯ КАПЧИ ───────────
  function isCaptchaHtml(html) {
    return /captcha|recaptcha|smartcaptcha|капч|я не робот|проверка безопасности|too many requests|слишком много/i.test(html);
  }

  function hasResultMarkers(doc) {
    // страница /about/ должна содержать хоть что-то из этого
    return Boolean(
      doc.querySelector('.a_2BCsImjE, .a_1v0mREgi, .a_gUeabJ7m, .a_Q198tavp, [itemprop="telephone"], a[href^="tel:"]')
    );
  }

  // ─────────── ТАЙМЕР КАПЧИ ───────────
  function startCaptchaCountdown(totalMs, onDone) {
    captchaBox.style.display = 'block';
    setDot('captcha');
    let remaining = Math.ceil(totalMs / 1000);

    function tick() {
      timerCount.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(captchaTimerInterval);
        captchaTimerInterval = null;
        onDone();
      }
      remaining--;
    }
    tick();
    captchaTimerInterval = setInterval(tick, 1000);
  }
  function stopCaptchaTimer() {
    if (captchaTimerInterval) {
      clearInterval(captchaTimerInterval);
      captchaTimerInterval = null;
    }
    captchaBox.style.display = 'none';
  }

  // ─────────── ОЖИДАНИЕ РАЗБЛОКИРОВКИ ───────────
  async function waitForCaptcha() {
    // Если уже кто-то ждёт — присоединяемся
    if (blockPromise) {
      await blockPromise;
      return;
    }

    // Первый поток поймал блок — создаём барьер
    blockPromise = new Promise(r => { blockResolve = r; });

    const settings = readSettings();
    const state = await loadState();
    if (state) {
      await saveState({
        ...state,
        waitingCaptcha: true,
        autoResumeAfterReload: settings.autoReload,
        captchaWaitMin: settings.captchaWaitMin,
      });
    }

    if (settings.autoReload) {
      // Умный таймер: ждём заданное время, затем перезагружаемся
      const waitMs = randCaptchaWait();
      setStatus(`Блокировка! Жду ${Math.ceil(waitMs/1000)} сек, затем перезагружу страницу…`, 'warn');
      aborted = true;
      setRunning(false);

      startCaptchaCountdown(waitMs, () => {
        stopCaptchaTimer();
        location.reload();
      });

      // Подвешиваем навсегда — reload прервёт
      return new Promise(() => {});
    }

    // Ручной режим
    setStatus('Блокировка сайта! Пройдите проверку и нажмите кнопку.', 'warn');
    setDot('captcha');
    btnCaptcha.style.display = 'block';

    // Умный таймер даже в ручном режиме — подсказка сколько примерно ждать
    const waitMs = randCaptchaWait();
    startCaptchaCountdown(waitMs, () => {
      // Время истекло, но пользователь ещё не нажал — показываем подсказку
      stopCaptchaTimer();
      timerLabel.textContent = 'Нажмите кнопку после прохождения капчи';
      captchaBox.style.display = 'block';
      timerCount.textContent = '✓';
    });

    await new Promise(r => {
      // Кнопка «капча пройдена» разблокирует это
      const handler = () => { btnCaptcha.removeEventListener('click', handler); r(); };
      btnCaptcha.addEventListener('click', handler);
    });
  }

  function unblockAll() {
    stopCaptchaTimer();
    btnCaptcha.style.display = 'none';
    blockPromise = null;
    if (blockResolve) {
      const fn = blockResolve;
      blockResolve = null;
      fn();
    }
  }

  // ─────────── FETCH С РЕТРАЯМИ ───────────
  async function fetchDoc(url) {
    const { maxRetries } = readSettings();

    let attemptsUsed = 0;
    while (attemptsUsed < maxRetries) {
      if (aborted) return null;

      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
      } catch (err) {
        attemptsUsed++;
        setStatus(`Сетевая ошибка (попытка ${attemptsUsed}/${maxRetries}): ${err.message}`, 'warn');
        await sleep(randDelay());
        continue;
      }

      // Блокировка / капча
      if (response.status === 429 || response.status === 403) {
        setStatus(`HTTP ${response.status} — блокировка…`, 'warn');
        await waitForCaptcha();
        if (aborted) return null;
        await sleep(1500);
        continue;
      }

      if (!response.ok) {
        attemptsUsed++;
        if (attemptsUsed >= maxRetries) {
          throw new Error(`HTTP ${response.status}`);
        }
        setStatus(`HTTP ${response.status} (попытка ${attemptsUsed}/${maxRetries})`, 'warn');
        await sleep(randDelay());
        continue;
      }

      const html = await response.text();
      const doc  = new DOMParser().parseFromString(html, 'text/html');

      // Капча в теле ответа
      if (isCaptchaHtml(html) && !hasResultMarkers(doc)) {
        setStatus('Капча в ответе…', 'warn');
        await waitForCaptcha();
        if (aborted) return null;
        await sleep(1500);
        continue;
      }

      return doc;
    }

    throw new Error(`Не удалось загрузить после ${maxRetries} попыток: ${url}`);
  }

  // ─────────── ПАРСИНГ КАРТОЧКИ СПИСКА ───────────
  function parseListCard(el, index) {
    const data = { '№': index + 1 };

    // Название и ссылка на профиль
    const profileHrefLink = el.querySelector('a[href*="/profiles/"]');
    const subdomainLink = el.querySelector('a[href*=".supl.biz/"]');
    const nameLink = profileHrefLink || subdomainLink;
    const nameDiv  = el.querySelector('.a_-zyjFuVn.a_OxpZyFuu');

    if (nameLink) {
      data['Название'] = norm(nameLink.textContent);
      data['Ссылка профиль'] = new URL(nameLink.getAttribute('href'), location.href).href;
    } else if (nameDiv) {
      data['Название'] = norm(nameDiv.textContent);
    }

    // Альтернативный поиск ссылки
    if (!data['Ссылка профиль']) {
      const anyProfileLink = el.querySelector('a[href*="/profiles/"], a[href*=".supl.biz/"]');
      if (anyProfileLink) {
        data['Ссылка профиль'] = new URL(anyProfileLink.getAttribute('href'), location.href).href;
        if (!data['Название']) data['Название'] = norm(anyProfileLink.textContent);
      }
    }

    // ИНН
    const allDivs = el.querySelectorAll('div');
    for (const d of allDivs) {
      const t = norm(d.textContent);
      const m = t.match(/ИНН[:\s]+(\d{10,12})/);
      if (m) { data['ИНН'] = m[1]; break; }
    }

    // Краткое описание
    const descDiv = el.querySelector('.a_79s95585, .a_-wk5V9nB');
    if (descDiv) data['Краткое описание'] = norm(descDiv.textContent);

    // Телефон (если виден)
    const phoneA = el.querySelector('a[href^="tel:"]');
    if (phoneA) data['Телефон (список)'] = norm(phoneA.textContent);

    // Адрес
    const addrCls = el.querySelector('.a_yQd0EOBT');
    if (addrCls) {
      const t = norm(addrCls.textContent).replace(/^Адрес:\s*/i, '');
      if (t) data['Адрес (список)'] = t;
    }

    // Оплата
    const payDiv = el.querySelector('.a_xixU-qtd');
    if (payDiv) data['Оплата (список)'] = norm(payDiv.textContent).replace(/^Способ оплаты:\s*/i, '');

    // Доставка
    const delDiv = el.querySelector('.a_58DvZwyY');
    if (delDiv) data['Доставка (список)'] = norm(delDiv.textContent).replace(/^Способ доставки:\s*/i, '');

    // Товары из карточки
    const products = [];
    el.querySelectorAll('a.a_GHjWmzoe').forEach(a => {
      const title = norm(a.querySelector('h3')?.textContent);
      const href  = a.getAttribute('href');
      if (title) products.push(title + (href ? ` (${new URL(href, location.href).href})` : ''));
    });
    if (products.length) data['Товары (превью)'] = products.join(' | ');

    return data;
  }

  // ─────────── ПАРСИНГ СТРАНИЦЫ /about/ ───────────
  function parseAboutPage(doc, aboutUrl) {
    const data = {};

    // Полное описание
    const descBlock = doc.querySelector('.a_1v0mREgi');
    if (descBlock) data['Описание полное'] = norm(descBlock.textContent);

    // Блок контактов
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const phones  = new Set();
    const emails  = new Set();
    const websites = new Set();
    const addrs  = new Set();

    // Телефон
    doc.querySelectorAll('a[href^="tel:"]').forEach(a => phones.add(norm(a.textContent)));

    // Email
    doc.querySelectorAll('a[href^="mailto:"]').forEach(a => emails.add(norm(a.textContent)));

    // Email в тексте
    const bodyText = doc.body?.textContent || '';
    (bodyText.match(emailRegex) || []).forEach(e => {
      if (!/\.(png|jpg|svg|gif|webp)/i.test(e)) emails.add(e);
    });

    // Сайты
    doc.querySelectorAll('a[href]').forEach(a => {
      const h = a.getAttribute('href').toLowerCase();
      if (h.startsWith('http') && !h.includes('supl.biz') && !h.includes('yandex')) {
        websites.add(a.getAttribute('href'));
      }
    });

    // Адрес
    doc.querySelectorAll('.a_hiycLRJ8, .a_Sgm4Yx6K').forEach(d => {
      const t = norm(d.textContent);
      if (t.length > 5 && !t.includes('@') && !/^\+/.test(t)) addrs.add(t);
    });

    if (phones.size)   data['Телефоны']  = [...phones].join(', ');
    if (emails.size)   data['Email']     = [...emails].join(', ');
    if (websites.size) data['Сайт']      = [...websites].join(', ');
    if (addrs.size)    data['Адрес']     = [...addrs].reduce((a, b) => a.length >= b.length ? a : b, '');

    // Оплата
    const payMethods = [];
    doc.querySelectorAll('.a_jY7EcKp5').forEach(d => {
      const t = norm(d.textContent);
      if (t) payMethods.push(t);
    });
    if (payMethods.length) {
      // Разделяем оплату и доставку по заголовкам h3
      let inPay = false, inDel = false;
      const pay = [], del = [];
      doc.querySelectorAll('h3, .a_jY7EcKp5').forEach(node => {
        if (node.tagName === 'H3') {
          const t = norm(node.textContent).toLowerCase();
          inPay = t.includes('оплат');
          inDel = t.includes('доставк');
        } else {
          const t = norm(node.textContent);
          if (t) {
            if (inPay) pay.push(t);
            if (inDel) del.push(t);
          }
        }
      });
      if (pay.length) data['Оплата']    = pay.join(', ');
      if (del.length) data['Доставка']  = del.join(', ');
    }

    // Сферы деятельности
    const spheres = [];
    doc.querySelectorAll('.a_dr6ALvtD').forEach(d => {
      const t = norm(d.textContent);
      if (t) spheres.push(t);
    });
    if (spheres.length) data['Сферы деятельности'] = spheres.join(', ');

    // Регионы
    // (второй блок .a_dr6ALvtD — регионы, первый — сферы, разделены h3)
    // Парсим аккуратно по h3
    let inSpheres = false, inRegions = false;
    const regions = [], spheresFinal = [];
    doc.querySelectorAll('h3, .a_dr6ALvtD').forEach(node => {
      if (node.tagName === 'H3') {
        const t = norm(node.textContent).toLowerCase();
        inSpheres = t.includes('сфер') || t.includes('деятельност');
        inRegions = t.includes('регион') || t.includes('работ');
      } else {
        const t = norm(node.textContent);
        if (t) {
          if (inSpheres) spheresFinal.push(t);
          if (inRegions) regions.push(t);
        }
      }
    });
    if (spheresFinal.length) data['Сферы деятельности'] = spheresFinal.join(', ');
    if (regions.length)      data['Регионы работы']     = regions.join(', ');

    data['Ссылка /about/'] = aboutUrl;
    return data;
  }

  // ─────────── ПОСТРОЕНИЕ URL /about/ ───────────
  function buildAboutUrl(profileUrl) {
    // Форматы:
    // https://supl.biz/profiles/h-9RJYbLBOyg/  → https://supl.biz/profiles/h-9RJYbLBOyg/about/
    // https://cacao-macao.supl.biz/             → https://cacao-macao.supl.biz/about/
    // https://supl.biz/profiles/h-9RJYbLBOyg   → добавляем /about/
    try {
      const u = new URL(profileUrl);
      const cleanPath = u.pathname.replace(/\/+$/, '');
      if (cleanPath.startsWith('/profiles/')) {
        return `${u.origin}${cleanPath}/about/`;
      }
      if (u.hostname.endsWith('.supl.biz')) {
        return `${u.origin}/about/`;
      }
      return `${u.origin}${cleanPath || ''}/about/`;
    } catch {
      return profileUrl + '/about/';
    }
  }

  async function resolveAboutCandidates(profileUrl) {
    const candidates = [];
    const primary = buildAboutUrl(profileUrl);
    candidates.push(primary);

    try {
      const u = new URL(profileUrl);
      if (u.hostname === 'supl.biz' && u.pathname.startsWith('/profiles/')) {
        const resp = await fetch(profileUrl, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
        });
        const finalUrl = new URL(resp.url || profileUrl);
        if (finalUrl.hostname.endsWith('.supl.biz')) {
          const alt = `${finalUrl.origin}/about/`;
          if (!candidates.includes(alt)) candidates.push(alt);
        }
      }
    } catch (_) {
      // fallback остаётся только на primary
    }

    return candidates;
  }

  // ─────────── ОБРАБОТКА ОДНОЙ КОМПАНИИ ───────────
  async function processCompany(listData, index, total) {
    const name = listData['Название'] || `компания ${index+1}`;
    if (!listData['Ссылка профиль']) {
      return { ...listData, 'Статус': 'Нет ссылки' };
    }

    setStatus(`[${index+1}/${total}] ${name}`);

    try {
      const aboutCandidates = await resolveAboutCandidates(listData['Ссылка профиль']);
      let lastError = null;

      for (const aboutUrl of aboutCandidates) {
        try {
          const doc = await fetchDoc(aboutUrl);
          if (!doc || aborted) return null;
          const aboutData = parseAboutPage(doc, aboutUrl);
          return {
            ...listData,
            ...aboutData,
            'Статус': 'OK',
          };
        } catch (err) {
          lastError = err;
        }
      }

      throw lastError || new Error('Не удалось открыть ни один вариант /about/');
    } catch (err) {
      return { ...listData, 'Статус': 'Ошибка', 'Ошибка': err.message };
    }
  }

  // ─────────── СБОР КАРТОЧЕК ───────────
  function collectCards() {
    return [...document.querySelectorAll('div.a_RU8Dmprq')];
  }

  // ─────────── CSV ───────────
  const CSV_HEADERS = [
    '№', 'Название', 'ИНН', 'Краткое описание',
    'Телефон (список)', 'Адрес (список)', 'Оплата (список)', 'Доставка (список)',
    'Товары (превью)',
    'Описание полное', 'Телефоны', 'Email', 'Сайт', 'Адрес', 'Оплата', 'Доставка',
    'Сферы деятельности', 'Регионы работы',
    'Ссылка профиль', 'Ссылка /about/',
    'Статус', 'Ошибка',
  ];

  function toCsv(val) {
    return '"' + String(val ?? '').replace(/\r?\n|\r/g, ' ').replace(/"/g, '""') + '"';
  }

  function downloadCsv(rows) {
    // Собираем все возможные ключи
    const allKeys = new Set(CSV_HEADERS);
    rows.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));
    const headers = [...allKeys];

    const lines = [
      headers.map(toCsv).join(';'),
      ...rows.map(row => headers.map(h => toCsv(row[h])).join(';')),
    ];
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `supl_${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ─────────── ОСНОВНОЙ ПАРСЕР ───────────
  async function runParser(resume = false) {
    aborted = false;
    blockPromise = null;
    blockResolve = null;
    await saveSettings();

    const { concurrency } = readSettings();

    const cards = collectCards();
    if (!cards.length) {
      setStatus('Карточки .a_RU8Dmprq не найдены на этой странице.', 'error');
      setRunning(false);
      return;
    }

    const savedState = await loadState();
    let startIndex = 0;
    let savedData  = [];

    if (resume && isSamePage(savedState)) {
      savedData  = savedState.data  || [];
      startIndex = savedState.rowIndex || 0;
      setStatus(`Продолжаю с позиции ${startIndex}/${cards.length}…`);
    } else {
      await clearState();
    }

    await saveState({
      data: savedData, rowIndex: startIndex, totalRows: cards.length,
      waitingCaptcha: false, autoResumeAfterReload: false,
    });

    setStatus(`Найдено: ${cards.length} компаний. Потоков: ${concurrency}.`);

    // Предварительный парсинг карточек списка
    const listDataArr = cards.map((el, i) => parseListCard(el, i));

    const results = new Array(cards.length).fill(null);
    savedData.forEach((item, i) => { results[i] = item; });

    let nextIndex     = startIndex;
    let completedCount = startIndex;

    async function worker() {
      for (;;) {
        if (aborted) return;
        const index = nextIndex;
        if (index >= cards.length) return;
        nextIndex++;

        const t0 = Date.now();
        const rowData = await processCompany(listDataArr[index], index, cards.length);
        if (aborted) return;

        results[index] = rowData || listDataArr[index];
        completedCount++;

        const flushData = results.slice(0, completedCount).filter(Boolean);
        await saveState({
          data: flushData, rowIndex: completedCount, totalRows: cards.length,
          waitingCaptcha: false, autoResumeAfterReload: false,
        });
        setProgress(completedCount, cards.length);

        if (nextIndex < cards.length) {
          const elapsed = Date.now() - t0;
          const wait = Math.max(0, randDelay() - elapsed);
          if (wait > 0) await sleep(wait);
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (aborted) {
      setStatus('Остановлено. Прогресс сохранён.', 'warn');
      setRunning(false);
      return;
    }

    const final = results.filter(Boolean);
    downloadCsv(final);
    resetProgress();
    await clearState();
    setStatus(`Готово! Скачано: ${final.length} компаний.`, 'success');
    setRunning(false);
    setDot('');
    btnStart.textContent = '▶ Запустить';
  }

  // ─────────── ИНИЦИАЛИЗАЦИЯ ───────────
  await loadSettings();

  const savedState = await loadState();
  if (isSamePage(savedState)) {
    btnStart.textContent = '▶ Продолжить';

    if (savedState.autoResumeAfterReload) {
      // Страница перезагрузилась после блокировки — запускаемся автоматически
      setStatus('Страница обновлена после блокировки. Продолжаю…', 'warn');
      setTimeout(() => {
        if (running) return;
        setRunning(true);
        runParser(true).catch((err) => {
          setStatus(`Критическая ошибка: ${err.message}`, 'error');
          setRunning(false);
          setDot('');
        });
      }, 800);
    } else if (savedState.waitingCaptcha) {
      setStatus('Парсер ждёт — пройдите проверку и нажмите кнопку.', 'warn');
      setDot('captcha');
      btnCaptcha.style.display = 'block';
    } else {
      setStatus(`Прогресс сохранён: ${savedState.rowIndex || 0} / ${savedState.totalRows || '?'}`, '');
    }
  }

  // ─────────── СОБЫТИЯ ───────────
  [delayMinEl, delayMaxEl, concurEl, retriesEl, cwaitMinEl, cwaitMaxEl, autoEl]
    .forEach(el => el.addEventListener('change', saveSettings));

  btnStart.addEventListener('click', async () => {
    const resume = btnStart.textContent.includes('Продолжить');
    setRunning(true);
    setDot('running');
    btnCaptcha.style.display = 'none';
    stopCaptchaTimer();
    runParser(resume).catch((err) => {
      setStatus(`Критическая ошибка: ${err.message}`, 'error');
      setRunning(false);
      setDot('');
    });
  });

  btnStop.addEventListener('click', () => {
    aborted = true;
    unblockAll();
    setRunning(false);
    setDot('');
  });

  btnCaptcha.addEventListener('click', async () => {
    stopCaptchaTimer();
    btnCaptcha.style.display = 'none';
    const state = await loadState();
    if (state) await saveState({ ...state, waitingCaptcha: false, autoResumeAfterReload: false });
    setStatus('Продолжаем…');
    setDot('running');
    unblockAll();

    if (!running) {
      setRunning(true);
      runParser(true).catch((err) => {
        setStatus(`Критическая ошибка: ${err.message}`, 'error');
        setRunning(false);
        setDot('');
      });
    }
  });

})();
