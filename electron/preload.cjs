const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('speakingProfessorDesktop', {
  isElectron: true,
  platform: process.platform,
});
