# Yiro App
Uygulama içerisinden bazı ekran görüntüleri...<br/>
<br/>
<img width="1920" height="1032" alt="Screenshot 2026-05-09 221729" src="https://github.com/user-attachments/assets/e15add41-3dcf-4566-aac9-dcbdcc1a58b8" />
<img width="1920" height="1032" alt="Screenshot 2026-05-09 221809" src="https://github.com/user-attachments/assets/cddc0524-712f-4de7-9f69-e5053bef62e1" />
<img width="1920" height="1032" alt="Screenshot 2026-05-09 221931" src="https://github.com/user-attachments/assets/9575e531-000c-4edc-a723-d108125e5c32" />
<img width="1920" height="1032" alt="Screenshot 2026-05-09 221854" src="https://github.com/user-attachments/assets/17962f26-a029-45d5-8148-968b2b9587ca" />
<img width="1920" height="1032" alt="Screenshot 2026-05-09 222314" src="https://github.com/user-attachments/assets/1c12d464-0b01-4751-8396-e0e59677319d" />
<br/>
<br/>
Spotify benzeri dinleme deneyimi: **FastAPI** API, **PostgreSQL** + **Alembic**, arayüz **Vite + TypeScript** ile derlenir; çıktı `app/static` altına yazılır ve tarayıcıda **http://localhost:8010/ui/** adresinden açılır.

## Gereksinimler

- Python 3.11+ (veya projeyle uyumlu 3.x)
- PostgreSQL
- Arayüzü derlemek için: Node.js 20+ ve npm

## Ortam (yalnızca lokal)

1. `.env.example` dosyasını `.env` olarak kopyala.
2. Yerelde çalışırken `.env.example` içindeki gibi bırakabilirsin:
   - `DATABASE_URL` → kendi Postgres kullanıcı / şifre / veritabanı adın (`spotify_backend` oluşturman yeterli).
   - `SECRET_KEY` → güçlü rastgele bir dize (örnek yer tutucuyu üretimde kullanma).
   - `UI_BASE_URL=http://localhost:8010` → CORS ve şifre sıfırlama linkleri için doğru kök adres.
3. `DEBUG=true` ile geliştirme rahat olur (ayrıntılar `.env.example` yorumlarında).
4. `.env` repoya eklenmez; sırları sadece kendi makinede tut.

İsteğe bağlı: `REDIS_URL` tanımlamazsan uygulama Redis olmadan da çalışır. Şifre sıfırlama e-postasını denemek istersen `.env.example` içindeki `SMTP_*` veya `RESEND_*` alanlarını doldurman yeterli.

## Kurulum (Windows / PowerShell)

```powershell
py -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
py -m pip install -r requirements.txt
```

PostgreSQL’de `spotify_backend` (veya `.env` içinde yazdığın isim) veritabanını oluştur, sonra:

```powershell
py -m alembic upgrade head
```

## Müzik ve örnek veri (isteğe bağlı)

- Şarkıları veritabanına almak (ses dosyaları `MUSIC_DIR` altında olmalı):

  `py scripts/import_local_dataset.py --audio-dir <klasor> [--manifest-csv yol.csv] [--itunes-enrich]`

- Örnek kullanıcılar ve etkileşim:

  `py scripts/seed_mock_users.py`

Diğer yardımcılar: `scripts/match_metadata.py`, `scripts/generate_recommendations.py`, `scripts/update_song_stream_urls.py`.

## Arayüzü derle

Proje kökünden:

```powershell
cd frontend
npm install
npm run build
```

Çıktı: `app/static/app.js`. Discover videoları için dosyaları `app/static/videos/` altına koyabilirsin; uygulama bunları `/ui/videos/` üzerinden sunar.

Sadece UI kodunda çalışmak için: `cd frontend` → `npm run dev` (ayrıntı `frontend/vite.config.ts`).

## Sunucuyu başlat

```powershell
py -m uvicorn app.main:app --reload --port 8010
```

- Arayüz: http://localhost:8010/ui/
- API dokümantasyonu: http://localhost:8010/docs/

Portu değiştirirsen `.env` içindeki `UI_BASE_URL` ve tarayıcı adresini aynı porta getir.

## Listen Together (lokal)

Oturumlar bu süreçte bellekte tutulur; **tek çalışan uvicorn** ile host ve misafir aynı makineden veya ağdaki diğer cihazlardan **aynı bilgisayarın IP’si ve portu** (ör. `http://192.168.x.x:8010`) ile bağlanırsa sorunsuz test edilir.

## Testler

```powershell
py -m pytest
```
