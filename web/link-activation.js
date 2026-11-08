export function shouldOpenExternalLink(event) {
  return Boolean(event && (event.ctrlKey || event.metaKey || event.detail === 0));
}
