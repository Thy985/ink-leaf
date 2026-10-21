// Shared editor stays platform-independent; only this adapter knows the Android bridge.
export const isAndroid = typeof window.InkLeafAndroid?.postMessage === 'function';
export const compactViewport = '(max-width: 640px), (max-width: 960px) and (max-height: 480px)';
const pending = new Map();
let sequence = 0;
window.addEventListener('inkleaf-native-result', ({ detail }) => {
  if (!detail || typeof detail.id !== 'string') return;
  const request = pending.get(detail.id);
  if (!request) return;
  pending.delete(detail.id);
  if (detail.error) request.reject(new Error(detail.error));
  else request.resolve(detail);
});
export function nativeFile(action, payload = {}) {
  if (!isAndroid || !['open', 'export'].includes(action)) return Promise.reject(new Error('系统文件接口不可用'));
  if (pending.size) return Promise.reject(new Error('请先完成当前文件操作'));
  const id = `file-${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try { window.InkLeafAndroid.postMessage(JSON.stringify({ ...payload, id, action })); }
    catch (error) { pending.delete(id); reject(error); }
  });
}

export function installMobileUI() {
  const root = document.documentElement;
  const toggle = document.getElementById('sidebar-toggle');
  const scrim = document.getElementById('outline-scrim');
  const mobile = matchMedia(compactViewport);
  const closeOutline = () => {
    document.body.classList.remove('mobile-outline');
    toggle.setAttribute('aria-expanded', String(!mobile.matches && !document.body.classList.contains('no-sidebar')));
  };
  scrim.addEventListener('click', closeOutline);
  document.getElementById('outline').addEventListener('click', event => {
    if (mobile.matches && event.target.closest('button')) closeOutline();
  });
  mobile.addEventListener('change', closeOutline);
  closeOutline();
  let frame;
  const resize = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      // Do not relayout during pinch zoom; keep magnification accessible.
      if (viewport && viewport.scale !== 1) return;
      root.style.setProperty('--app-height', `${viewport?.height || window.innerHeight}px`);
      root.style.setProperty('--viewport-top', `${viewport?.offsetTop || 0}px`);
    });
  };
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(document.querySelector('.topbar'));
  resize();
  window.addEventListener('inkleaf-back', event => {
    const handled = document.body.classList.contains('mobile-outline') || document.querySelector('dialog[open]') || !document.getElementById('find-panel').hidden || document.body.classList.contains('focus-mode');
    if (handled) event.preventDefault();
    if (document.body.classList.contains('mobile-outline')) closeOutline();
    else if (document.querySelector('dialog[open]')) document.querySelector('dialog[open]').close('cancel');
    else if (!document.getElementById('find-panel').hidden) document.getElementById('find-close').click();
    else if (document.body.classList.contains('focus-mode')) document.getElementById('exit-focus').click();
    else document.activeElement?.blur();
  });
  if (isAndroid) {
    document.body.classList.add('android');
    document.getElementById('save').textContent = '导出 .md';
    document.getElementById('open').textContent = '导入';
    document.querySelector('.edition').textContent = 'ANDROID · 本地离线';
    document.querySelector('.mvp').textContent = 'Android 适配预览';
  }
}
