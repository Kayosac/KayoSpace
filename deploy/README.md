# Хаб Kayospace на VPS

Хаб в интернете: планшет, мак и Windows синхронизируются через него из любой сети, Claude Code подключается
по MCP. Доступ — по токену, соединение — по HTTPS (сертификат Let's Encrypt получает Caddy).
Свой домен не обязателен: используется адрес вида `203-0-113-5.sslip.io`, который сам указывает на IP сервера.

## 1. Сервер

Подойдёт любой VPS:

- Ubuntu 24.04 или 22.04 (Debian 12 тоже подойдёт);
- 1 ГБ памяти и больше, 10 ГБ диска;
- публичный IPv4-адрес;
- открытые входящие порты 80 и 443 (если у провайдера есть свой файрвол в панели — откройте их там).

## 2. Установка — одна команда

Подключитесь к серверу по SSH (провайдер даст IP и пароль или ключ):

```bash
ssh root@<IP-сервера>
```

и выполните:

```bash
curl -fsSL https://raw.githubusercontent.com/Kayosac/KayoSpace/main/deploy/setup.sh | sudo bash
```

Скрипт сам: поставит Docker, скачает код в `/opt/kayospace`, придумает токен и адрес `<IP>.sslip.io`,
соберёт и запустит хаб с HTTPS, дождётся сертификата и напечатает всё нужное для подключения:

```
Готово. Хаб работает: https://203-0-113-5.sslip.io

  Адрес хаба:  203-0-113-5.sslip.io
  Токен:       4f1c…

Claude Code на своём компьютере:
  claude mcp add --transport http kayospace https://203-0-113-5.sslip.io/mcp --header "Authorization: Bearer 4f1c…"
```

Сохраните токен — это пароль к доскам. Посмотреть его снова: `cat /opt/kayospace/deploy/.env`.

Свой домен вместо sslip.io: направьте A-запись домена на IP сервера и перед первой установкой задайте
`HUB_DOMAIN`:

```bash
curl -fsSL https://raw.githubusercontent.com/Kayosac/KayoSpace/main/deploy/setup.sh | sudo HUB_DOMAIN=hub.example.com bash
```

## 3. Подключение устройств

**Планшет и мак (Pen Lab / приложение):** Настройки → Синхронизация → Хаб: адрес из вывода скрипта (без
`https://`), Токен: строка из вывода, Доска: любое имя (например `pen-lab`) → Подключить. В шапке появится
«Хаб: синхронизировано».

**Claude Code:** выполните на своём компьютере команду `claude mcp add …` из вывода скрипта, затем в любой
папке запустите `claude` и попросите, например, «прочитай доску pen-lab через kayospace».

## Обслуживание

| Что                           | Команда на сервере                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Обновить хаб до свежей версии | повторить команду установки                                                                                            |
| Логи                          | `cd /opt/kayospace/deploy && docker compose logs -f hub`                                                               |
| Перезапуск                    | `cd /opt/kayospace/deploy && docker compose restart`                                                                   |
| Остановить                    | `cd /opt/kayospace/deploy && docker compose down`                                                                      |
| Резервная копия досок         | `docker run --rm -v kayospace_hub-data:/data -v "$PWD":/backup alpine tar czf /backup/kayospace-boards.tgz -C /data .` |
| Сменить токен                 | изменить `HUB_TOKEN` в `/opt/kayospace/deploy/.env`, затем `docker compose up -d`                                      |

## Что пока не сделано

- ChatGPT и приложение Claude (claude.ai) требуют вход через OAuth — появится в фазе 3. Claude Code работает
  уже сейчас, с токеном в заголовке.
- Автоматические резервные копии во внешнее хранилище — фаза 2.
