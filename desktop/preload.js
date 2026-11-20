// Narrow, explicit bridge between the pages and the main process.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('kcs', {
  cfg: {
    status: call('cfg:status'),
    setup: call('cfg:setup'),
    unlock: call('cfg:unlock'),
    setVoterUrl: call('cfg:setVoterUrl'),
    changePassword: call('cfg:changePassword'),
    importFile: call('cfg:importFile'),
    exportFile: call('cfg:exportFile'),
    reset: call('cfg:reset'),
  },
  xlsx: { open: call('xlsx:open'), template: call('xlsx:template') },
  exportXlsx: call('export:xlsx'),
  exportPdf: call('export:pdf'),
  qr: { dataUrl: call('qr:dataUrl'), savePng: call('qr:savePng'), posterPdf: call('qr:posterPdf'), print: call('qr:print') },
  showFile: call('file:show'),
  update: {
    status: call('update:status'),
    check: call('update:check'),
    install: call('update:install'),
    releases: call('update:releases'),
    onStatus: (fn) => ipcRenderer.on('update:status', (_e, s) => fn(s)),
  },
  display: {
    open: call('display:open'),
    close: call('display:close'),
    isOpen: call('display:isOpen'),
    fullscreen: call('display:fullscreen'),
    send: call('display:state'),
    onState: (fn) => ipcRenderer.on('display:state', (_e, s) => fn(s)),
    onClosed: (fn) => ipcRenderer.on('display:closed', () => fn()),
  },
});
