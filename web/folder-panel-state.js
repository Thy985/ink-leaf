export function beginFolderScan(state, folderPath, blocked) {
  if (blocked) return false;
  state.activeFolder = folderPath;
  state.lastScan = null;
  return true;
}
