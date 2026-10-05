# Koç Market 2.0.4 — Bozuk Türkçe Adların Onarımı

- 2.0.3'ün çözemediği, görünmeyen karakterler içeren bozuk metinler için onarım genişletildi. İç içe Windows-1252 ve Latin-1 katmanları birlikte çözülür.
- Önizlemeden önce güncel verilerin tamamı ayrı bir dosyaya yedeklenir ve yedek okunarak doğrulanır. Onarım yalnızca “Onar ve Yenile” onayıyla uygulanır.
- Barkodlar, kimlikler, fiyatlar, tutarlar ve kayıt sayıları korunur. Eski yedek geri yüklenmez; yeni satışlar mevcut verilerde kalır.
- Onarım sırasında yazma ve yenileme engellenir. Açık sepet varsa önce satışın tamamlanması veya beklemeye alınması istenir.
- Sıfır düzeltme ve çözülemeyen metinler varsa ekran artık sorunun devam ettiğini açıkça belirtir. Kayıplı metinler tahminle değiştirilmez. Tekrarlanan onarım temiz metinleri değiştirmez.
- Electron'dan ilk geçiş ve yeniden açılış için Türkçe karakterleri ve yeni satışları koruyan ek kontroller eklendi.
- 2.0.2'deki UTF-8 açılış düzeltmesi korunur; onarım ekranı da kodlamadan etkilenmeyen ASCII kaçışlarıyla aktarılır.
