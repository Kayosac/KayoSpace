# Kayospace

Личный воркспейс: бесконечный холст, стилус, проекты и доступ для агентов (Claude Code, ChatGPT) через MCP.
Платформы: macOS, Windows, Android.

Сейчас идёт **фаза 1**: основной холст. Полный план — [docs/PLAN.md](docs/PLAN.md).

## Что внутри

```
apps/
  workspace/    основное приложение: бесконечный холст (React + свой движок)
  pen-lab/      стенд замера пера (веб, Vite)
  app/          оболочка Tauri 2 для macOS, Windows, Android (показывает workspace)
packages/
  model/        типы элементов холста, бинарный формат штрихов
  ink/          ввод пера (Pointer Events), отрисовка штрихов, статистика задержки
  board/        доска на Yjs: элементы, изменения, экспорт в Markdown/JSON для агентов
  sync/         протокол синхронизации и клиент (браузер и Node)
  canvas/       движок холста: камера, сцена, отрисовка, навигация, инструменты
server/
  hub/          хаб: синхронизация досок, хранение на диске, MCP для агентов
e2e/            проверки в настоящем браузере (Playwright) вместе с хабом
docs/           план, решения (ADR), инструкции
```

## Быстрый старт на Маке

Нужно: Node 22+, pnpm, для приложения — Rust и Xcode Command Line Tools.

```bash
# один раз
corepack enable                 # включает pnpm, версия берётся из package.json
xcode-select --install          # если ещё не стоит
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# в папке проекта
pnpm install
pnpm test                       # тесты пакетов
pnpm dev                        # приложение в браузере: http://localhost:5180
pnpm pen-lab                    # Pen Lab: http://localhost:5173
```

### Pen Lab на планшете без сборки приложения

```bash
pnpm pen-lab:lan                # дев-сервер Pen Lab доступен в локальной сети
```

Откройте на планшете `http://<IP-мака>:5173`. По HTTP без TLS браузер не даёт «сырые события» (pointerrawupdate) —
это нормально, их проверим в приложении. Ещё проще — опубликованная страница Pen Lab из чата: она открывается по HTTPS.

### Приложение для macOS

```bash
pnpm app:dev                    # окно Tauri с горячей перезагрузкой
pnpm app:build                  # .app и .dmg в apps/app/src-tauri/target/release/bundle
```

### Приложение для Android

1. Поставьте Android Studio, в SDK Manager — Android SDK, NDK (Side by side), Command-line Tools.
2. Пропишите переменные окружения (например, в `~/.zshrc`):
   ```bash
   export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 $ANDROID_HOME/ndk | tail -1)"
   ```
3. Добавьте Rust-цели:
   ```bash
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```
4. Сгенерируйте Android-проект и иконки:
   ```bash
   pnpm app:android:init
   pnpm --filter @kayospace/app icons
   ```
5. Включите на планшете «Отладку по USB», подключите кабелем и запустите:
   ```bash
   pnpm app:android:dev            # приложение на планшете с горячей перезагрузкой
   pnpm app:android:build          # APK в apps/app/src-tauri/gen/android/app/build/outputs/apk
   ```

### Приложение для Windows

На Windows-машине: Node 22, pnpm, Rust, «Desktop development with C++» из Visual Studio Build Tools
(WebView2 уже есть в Windows 10/11). Затем `pnpm install` и `pnpm app:build`.

## Хаб: синхронизация и агенты

```bash
pnpm hub
```

Хаб печатает адреса: MCP для агентов, адрес для планшета в локальной сети и готовую команду для Claude Code.
Доски хранятся в `server/hub/data/`.

**Claude Code.** Подключите один раз:

```bash
claude mcp add --transport http kayospace http://localhost:4000/mcp
```

Дальше можно просить: «прочитай доску pen-lab», «добавь на доску plan стикеры с задачами на неделю»,
«найди на досках всё про шрифты». Инструменты: `list_boards`, `read_board`, `add_sticky`, `search`.
MCP-эндпоинт принимает запросы только с этого компьютера.

**Планшет ↔ компьютер.** В Pen Lab (приложение или `pnpm dev`) откройте «Настройки» → «Синхронизация»,
введите адрес хаба из вывода `pnpm hub` (например `192.168.1.10:4000`), имя доски — и «Подключить».
Штрихи с планшета появятся на компьютере и наоборот, отмена и очистка тоже синхронизируются.
Опубликованная HTTPS-страница Pen Lab к хабу в локальной сети подключиться не может — браузер запрещает
незашифрованное соединение со страницы по HTTPS.

ChatGPT и приложение Claude подключаются только к публичному HTTPS-адресу с OAuth — это фаза 3.

## Хаб на VPS

Чтобы устройства синхронизировались из любой сети, хаб ставится на VPS одной командой — с HTTPS и доступом
по токену, свой домен не нужен. Подробно — [deploy/README.md](deploy/README.md):

```bash
curl -fsSL https://raw.githubusercontent.com/Kayosac/KayoSpace/main/deploy/setup.sh | sudo bash
```

## CI и готовые сборки

- **CI** (`.github/workflows/ci.yml`) — на каждый пуш в `main` и пулл-реквест: типы, линтер, тесты, сборка Pen Lab.
- **Сборка приложения** (`.github/workflows/app.yml`) — вручную: Actions → «Сборка приложения» → Run workflow
  (можно выбрать платформы) или пушем тега `v*`. Результаты — во вкладке Artifacts у запуска:
  - `kayospace-android-apk` — debug-APK для планшета (ARM64): распаковать zip, перекинуть APK на планшет и установить
    (разрешите установку из неизвестных источников);
  - `kayospace-macos` — `.dmg` (без подписи: при первом запуске — правый клик → «Открыть»);
  - `kayospace-windows` — установщики `.msi` и `.exe`.

Пока в репозитории нет `pnpm-lock.yaml`, CI ставит зависимости без него. После первого `pnpm install` закоммитьте
lock-файл — CI сам перейдёт на `--frozen-lockfile`.

## Команды

| Команда                                           | Что делает                                              |
| ------------------------------------------------- | ------------------------------------------------------- |
| `pnpm dev`                                        | Приложение в браузере (http://localhost:5180)           |
| `pnpm dev:lan`                                    | То же, доступно в локальной сети                        |
| `pnpm pen-lab`                                    | Pen Lab в браузере (http://localhost:5173)              |
| `pnpm e2e`                                        | Проверки в браузере вместе с хабом (Playwright)         |
| `pnpm test`                                       | Тесты всех пакетов (Vitest)                             |
| `pnpm typecheck`                                  | Проверка типов                                          |
| `pnpm lint` / `pnpm format`                       | ESLint / Prettier                                       |
| `pnpm --filter @kayospace/pen-lab build:single`   | Pen Lab одним HTML-файлом в `apps/pen-lab/dist-single/` |
| `pnpm app:dev` / `pnpm app:build`                 | Приложение для текущей ОС                               |
| `pnpm app:android:dev` / `pnpm app:android:build` | Приложение для Android                                  |
