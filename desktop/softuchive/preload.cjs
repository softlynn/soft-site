const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("softuchive", {
  getState: () => ipcRenderer.invoke("softuchive:get-state"),
  archiveNow: () => ipcRenderer.invoke("softuchive:archive-now"),
  pauseArchive: () => ipcRenderer.invoke("softuchive:pause"),
  resumeArchive: () => ipcRenderer.invoke("softuchive:resume"),
  skipCurrentVod: () => ipcRenderer.invoke("softuchive:skip-current-vod"),
  restartArchive: () => ipcRenderer.invoke("softuchive:restart"),
  setUploadControl: (payload) => ipcRenderer.invoke("softuchive:set-upload-control", payload),
  setAutoPolling: (payload) => ipcRenderer.invoke("softuchive:set-auto-polling", payload),
  saveSettings: (payload) => ipcRenderer.invoke("softuchive:save-settings", payload),
  pickArchiveFolder: () => ipcRenderer.invoke("softuchive:pick-archive-folder"),
  openLogs: () => ipcRenderer.invoke("softuchive:open-logs"),
  openArchiveFolder: () => ipcRenderer.invoke("softuchive:open-archive-folder"),
  onState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("softuchive:state", listener);
    return () => {
      ipcRenderer.removeListener("softuchive:state", listener);
    };
  },
});
