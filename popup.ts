import browser from 'webextension-polyfill';

import { bindExtensionSettings } from './settings-form';

bindExtensionSettings();

const statusEl = document.getElementById('status');

async function runOnPage(message: Record<string, unknown>): Promise<void> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId == null) {
    if (statusEl) statusEl.textContent = '没有可用的页面';
    return;
  }
  try {
    await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
    window.close();
  } catch {
    if (statusEl) statusEl.textContent = '这个页面不能使用采集功能';
  }
}

document.getElementById('batch-save')?.addEventListener('click', () => {
  void runOnPage({ type: 'serpent-open-batch' });
});
document.getElementById('capture-visible')?.addEventListener('click', () => {
  void runOnPage({ type: 'serpent-start-capture', mode: 'visible' });
});
document.getElementById('capture-area')?.addEventListener('click', () => {
  void runOnPage({ type: 'serpent-start-capture', mode: 'area' });
});
document.getElementById('capture-element')?.addEventListener('click', () => {
  void runOnPage({ type: 'serpent-start-capture', mode: 'element' });
});
document.getElementById('capture-page')?.addEventListener('click', () => {
  void runOnPage({ type: 'serpent-start-capture', mode: 'page' });
});
