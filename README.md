# Views Tracker — статистика TikTok

Сайт на GitHub Pages + сбор через Apify в GitHub Actions каждые 6 часов.

## Как устроено
- `scripts/collect.mjs` — сборщик. Быстрый сбор: `dami_studio~tiktok-scraper` (профиль + ~10 свежих видео, ~$0.25/1000 строк). Полный пересчёт всех видео (до 300): `clockworks~tiktok-scraper` — для нового аккаунта и раз в 30 дней.
- `.github/workflows/collect.yml` — расписание (каждые 6 ч) и ручной запуск.
- `accounts.json` — список аккаунтов. `data/state.json` — текущие цифры и видео, `data/history.json` — история для графиков и роста за 24 ч.
- `index.html`, `style.css`, `app.js`, `config.js` — сам сайт.

## Настройка (один раз)
1. **Секрет Apify:** Settings → Secrets and variables → Actions → New repository secret → имя `APIFY_TOKEN`, значение — токен из Apify (Settings → API & Integrations).
2. **Pages:** Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)` → Save.
3. **Токен для сайта:** github.com/settings/personal-access-tokens/new → Fine-grained → Repository access: *Only select repositories* → TikTokStats → Permissions: **Contents: Read and write**, **Actions: Read and write** → Generate. Вставить на сайте в Настройках.

## Пароль
В `config.js` поле `passHash` — SHA-256 пароля. Пусто — без пароля. Это защита от случайных людей: файлы с данными в публичном репозитории всё равно доступны.
