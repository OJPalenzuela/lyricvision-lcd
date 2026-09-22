'use strict';

/**
 * LyricVision LCD — preload (LV-05).
 *
 * Minimal renderer surface. Tokens NEVER cross this boundary: settings:get
 * returns `{connected, expiresAt}` for Spotify state, never the accessToken.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricvision', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  previewScene: (scene) => ipcRenderer.invoke('scene:preview', scene),
  connectSpotify: (clientId) => ipcRenderer.invoke('spotify:connect', { clientId }),
  listDisplays: () => ipcRenderer.invoke('display:list'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  hide: () => ipcRenderer.invoke('window:hide'),
  show: () => ipcRenderer.invoke('window:show'),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  setStartup: (enabled) => ipcRenderer.invoke('startup:set', enabled),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  onPlayerState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('player-state', listener);
    return () => ipcRenderer.removeListener('player-state', listener);
  },
  onSpotifyAuth: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('spotify-auth', listener);
    return () => ipcRenderer.removeListener('spotify-auth', listener);
  },
});
