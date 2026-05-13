// background.js — Supl.biz Parser v2
// Следит за 429-ошибками и автоматически перезагружает вкладку после задержки

const STATE_KEY = 'supl-parser-state-v2';

// Слушаем навигационные ошибки (сеть / 429)
chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const is429 =
    details.error === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' ||
    details.error === 'net::ERR_TOO_MANY_REQUESTS';

  if (!is429) return;

  const result = await chrome.storage.local.get(STATE_KEY);
  const state = result[STATE_KEY];
  if (!state?.autoResumeAfterReload) return;

  const reloadAfterMs = (state.captchaWaitMin ?? 30) * 1000;
  setTimeout(() => {
    chrome.tabs.reload(details.tabId, { bypassCache: false });
  }, reloadAfterMs);
});
