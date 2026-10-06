const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fake", { emit: (ev) => ipcRenderer.send("event", ev) });
