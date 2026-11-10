# JN Service Report

App service report untuk field engineer. Diisi di phone, berfungsi tanpa internet, dan semua rekod disimpan berpusat dalam Google Sheets.

- **Nombor report berkongsi** untuk semua engineer: `JNA001`, `JNA002` … `JNA999`, kemudian `JNB001` dan seterusnya. Nombor dikeluarkan oleh server, jadi tidak akan bertindih.
- **Offline:** report boleh diisi dan dihantar tanpa internet. Ia dihantar automatik dan mendapat nombor bila ada sambungan.
- **Tandatangan jari** untuk pelanggan dan engineer.
- **PDF A4** dengan logo, dan teks panjang tidak terpotong. Boleh dikongsi terus ke WhatsApp atau email.
- **Rekod:** semua report dari semua engineer boleh dicari dalam app. Ada juga eksport CSV.

## Kandungan folder

| Folder / fail | Kegunaan |
|---|---|
| `www/` | App (PWA). Inilah yang dibuka di phone. |
| `apps-script/Code.gs` | Backend Google Sheets: simpan rekod dan keluarkan nombor report. |
| `android/` | Projek Android (Capacitor) untuk dibina menjadi APK. |
| `.github/workflows/` | Bina APK dan hos PWA secara automatik di GitHub. |

---

## Langkah 1: Sediakan Google Sheets (sekali sahaja, oleh admin)

1. Buka [sheets.new](https://sheets.new) untuk Google Sheet baharu. Namakan, contohnya, "JN Service Report".
2. Klik **Extensions > Apps Script**.
3. Padam kod sedia ada. Tampal semua kandungan `apps-script/Code.gs`.
4. Pada baris `const TOKEN = 'TUKAR-KATA-LALUAN-INI';`, tukar kepada kata laluan rahsia anda. Tekan **Save**.
5. Di toolbar, pilih fungsi **setup** dan tekan **Run**. Benarkan akses bila diminta. Sheet `Reports` dan `Config` akan dicipta.
6. Klik **Deploy > New deployment**, ikon gear, kemudian **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Tekan **Deploy**. Salin **Web app URL** (berakhir dengan `/exec`).

Berikan URL dan token kepada setiap engineer. Mereka isikan dalam **Tetapan** di app.

**Nota:**
- **Nombor permulaan:** tab `Config`, sel `B1`, menyimpan nombor terakhir yang dikeluarkan. Biarkan kosong untuk mula dari `JNA001`. Untuk sambung dari nombor lama, isikan nombor terakhir (contohnya `JNA120`), dan report seterusnya akan menjadi `JNA121`.
- **Kemas kini kod:** jika kod diubah, guna **Deploy > Manage deployments > Edit > Version: New version** supaya URL kekal sama.
- **Lihat rekod:** semua report boleh dibaca terus dalam tab `Reports`.

## Langkah 2: Pasang app di phone

### Pilihan A: PWA (paling cepat)
1. Muat naik folder ini ke repo GitHub. Di **Settings > Pages**, pilih **Source: GitHub Actions**. Aliran kerja `Deploy PWA` akan menghos app di `https://<nama-anda>.github.io/<repo>/`.
   - Alternatif: seret folder `www/` ke [app.netlify.com/drop](https://app.netlify.com/drop).
2. Buka alamat itu dengan Chrome di phone. Pilih menu ⋮ kemudian **Add to Home screen / Install app**.

### Pilihan B: APK
**Cara automatik (tanpa Android Studio):** push repo ini ke GitHub. Buka tab **Actions > Build APK**, tunggu run selesai, kemudian muat turun `JN-Service-Report-APK` di bahagian *Artifacts*. Ekstrak zip dan pasang `app-debug.apk` di phone. Benarkan "Install unknown apps" bila diminta.

**Cara manual di PC:**
1. Pasang [Node.js 20+](https://nodejs.org) dan [Android Studio](https://developer.android.com/studio).
2. Dalam folder ini, jalankan:
   ```
   npm install
   npx cap sync android
   npx cap open android
   ```
3. Dalam Android Studio: **Build > Build App Bundle(s) / APK(s) > Build APK(s)**.

Setiap kali fail dalam `www/` diubah, jalankan `npx cap sync android` sebelum membina semula.

APK debug sesuai untuk kegunaan dalaman syarikat. Untuk Google Play, perlu APK/AAB *release* yang ditandatangani (**Build > Generate Signed Bundle / APK**).

## Langkah 3: Tetapan di setiap phone

Buka app, tekan ikon gear dan isikan:
- **Nama engineer**
- **URL web app** (dari Langkah 1)
- **Token**

Tekan **Uji sambungan**, kemudian **Simpan tetapan**.

---

## Cara guna

1. **Report Baharu.** Pilih jenis kerja dan isi butiran. Medan seperti client dan equipment mencadangkan nilai daripada report lama.
2. **Tandatangan.** Ketik kotak atau butang **Lukis** untuk tandatangan dengan jari. Untuk tandatangan atas kertas, guna **Kamera** (ambil gambar) atau **Galeri** (pilih gambar sedia ada). Latar kertas dijadikan putih dan gambar dipotong mengikut tandatangan secara automatik. Ada juga butang **Putar** dan pilihan untuk mengekalkan gambar asal.
3. **Hantar & Dapat No.** Report dihantar ke server dan menerima nombor (contohnya `JNA015`). Jika offline, report berstatus *Belum sync* dan dihantar automatik bila ada internet.
4. **Simpan Draf.** Disimpan dalam phone sahaja dan belum mendapat nombor.
5. **PDF.** Buka report, kemudian **Kongsi PDF** (WhatsApp, email, Drive) atau **Muat turun PDF**.
6. **Salin ke report baharu.** Menyalin butiran client dan equipment. Sesuai untuk PPM berulang.

Report yang sudah bernombor masih boleh diedit. Nombornya kekal dan server dikemas kini.

## Menukar maklumat syarikat atau logo
- **Nama, alamat dan jenis kerja:** ubah `COMPANY` dan `WORK_TYPES` di bahagian atas `www/app.js`.
- **Logo:** gantikan `www/logo.jpg`.
- **Selepas mengubah fail app:** naikkan `CACHE` dalam `www/sw.js` (contohnya `jn-sr-v1.0.1`) supaya phone memuat versi baharu.
