# Kayospace

Личный воркспейс: бесконечный холст, стилус, проекты и доступ для агентов (Claude Code, ChatGPT) через MCP.
Платформы: macOS, Windows, Android.

Сейчас идёт **фаза 0**: фундамент и замер пера. Полный план — [docs/PLAN.md](docs/PLAN.md).

## Что внутри

```
apps/
  pen-lab/      стенд замера пера (веб, Vite) — первый спайк
  app/          оболочка Tauri 2 для macOS, Windows, Android (пока показывает Pen Lab)
packages/
  model/        типы элементов холста, бинарный формат штрихов
  ink/          ввод пера (Pointer Events), отрисовка штрихов, статистика задержки
server/         хаб: синхронизация + MCP (появится в спайке синка)
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
pnpm dev                        # Pen Lab в браузере: http://localhost:5173
```

### Pen Lab на планшете без сборки приложения

```bash
pnpm dev:lan                    # дев-сервер доступен в локальной сети
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
| `pnpm dev`                                        | Pen Lab в браузере                                      |
| `pnpm dev:lan`                                    | То же, доступно в локальной сети                        |
| `pnpm test`                                       | Тесты всех пакетов (Vitest)                             |
| `pnpm typecheck`                                  | Проверка типов                                          |
| `pnpm lint` / `pnpm format`                       | ESLint / Prettier                                       |
| `pnpm --filter @kayospace/pen-lab build:single`   | Pen Lab одним HTML-файлом в `apps/pen-lab/dist-single/` |
| `pnpm app:dev` / `pnpm app:build`                 | Приложение для текущей ОС                               |
| `pnpm app:android:dev` / `pnpm app:android:build` | Приложение для Android                                  |
