'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = new Set(['restore', 'open', 'new', 'save', 'saveAs', 'close', 'openPending']);
function validAction(action) { if (typeof action !== 'string' || !ACTIONS.has(action)) throw new Error('未知桌面操作'); return action; }
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  perform(action, snapshot) { return ipcRenderer.invoke('desktop:perform', validAction(action), snapshot); },
  syncState(state) { ipcRenderer.send('desktop:state', state); },
  onCommand(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback 必须是函数');
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('desktop:command', listener);
    return () => ipcRenderer.removeListener('desktop:command', listener);
  }
}));
