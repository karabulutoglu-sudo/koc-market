# Koç Market 2.1.0 — Yayın 1 Ön Sürümü

- Satış tutarları kuruş üzerinden hesaplanır. CSV içe aktarımında ondalık virgül ve nokta ile yüzde sıfır KDV desteklenir. Eski fişler satış anındaki KDV oranını kullanır.
- Nakit ve veresiye satışlar stok ve ilgili cari hareketlerle birlikte kaydedilir. Bekletilen sepet ancak kayıt onayından sonra kapanır.
- Cari avans ödemeleri sonraki borçlardan düşülür. Hareketi olan cari pasife alınabilir. Cari yedeklerinde bakiye, hareketler ve satış bağlantıları birlikte korunur.
- İlk açılışta günlük yedek alınır. Günlük yedek ve gün bilgisi birlikte kaydedilir. Depolama motoru değişiminde doğrulanmış kaynak yedekleri korunur.
- Kasa ve yönetici yetkileri ayrıldı. Yönetici PIN'i güvenli özetle saklanır. PDF fiyat listeleri internet bağlantısı olmadan okunabilir.
- İşletme bilgileri, varsayılan KDV ve stok kuralları Ayarlar'dan yönetilebilir. Ürün kategorileri alt kategorilerle düzenlenebilir.
