// preload.js — renderer ile main arasında güvenli, SENKRON disk depolama köprüsü.
// contextIsolation:true + nodeIntegration:false altında çalışır.
// Mevcut kod senkron localStorage gibi çalıştığı için sendSync kullanıyoruz;
// böylece çağrı yerlerini async'e çevirmeye gerek kalmaz.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kocStore', {
  // Diskten oku → string | null
  read:   (key)      => ipcRenderer.sendSync('kocstore:read', String(key)),
  // Diske yaz (atomik) → true/false
  write:  (key, val) => ipcRenderer.sendSync('kocstore:write', { key: String(key), val: String(val) }),
  // Anahtarı sil → true/false
  remove: (key)      => ipcRenderer.sendSync('kocstore:remove', String(key)),
  // Tüm anahtarları döndür → string[]
  keys:   ()         => ipcRenderer.sendSync('kocstore:keys')
});
