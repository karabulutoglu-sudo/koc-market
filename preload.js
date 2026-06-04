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

// Gerçek "Farklı Kaydet" / "Aç" pencereleri (Electron dialog). Asenkron.
contextBridge.exposeInMainWorld('kocFile', {
  // "Farklı kaydet" penceresi aç, seçilen yola yaz → {ok,path} | {canceled} | {ok:false,error}
  save: (defaultName, contents) =>
    ipcRenderer.invoke('kocfile:save', { defaultName: String(defaultName), contents: String(contents) }),
  // Dosya seçtir, içeriğini oku → {ok,contents,path} | {canceled} | {ok:false,error}
  open: () => ipcRenderer.invoke('kocfile:open')
});
