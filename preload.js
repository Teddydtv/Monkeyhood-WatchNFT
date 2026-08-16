const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (cfg) => ipcRenderer.invoke('save-settings', cfg),
  getWatcherStatus: () => ipcRenderer.invoke('get-watcher-status'),
  startWatcher: () => ipcRenderer.invoke('start-watcher'),
  stopWatcher: () => ipcRenderer.invoke('stop-watcher'),
  exitApp: () => ipcRenderer.invoke('exit-app'),
  pollNow: () => ipcRenderer.invoke('poll-now'),
  dismissAlert: (slug) => ipcRenderer.invoke('dismiss-alert', slug),
  addOwned: (slug) => ipcRenderer.invoke('add-owned', slug),
  removeOwned: (slug) => ipcRenderer.invoke('remove-owned', slug),
  searchAddCollection: (query) => ipcRenderer.invoke('search-add-collection', query),
  onEthUpdate: (cb) => ipcRenderer.on('eth-update', (_e, data) => cb(data)),
  onCollectionsUpdate: (cb) => ipcRenderer.on('collections-update', (_e, data) => cb(data)),
  onCollectionsError: (cb) => ipcRenderer.on('collections-error', (_e, msg) => cb(msg)),
  onAlertsUpdate: (cb) => ipcRenderer.on('alerts-update', (_e, data) => cb(data)),
  onWatcherStatus: (cb) => ipcRenderer.on('watcher-status', (_e, data) => cb(data))
});
