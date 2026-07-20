# OpenCode Session Manager — Russian README

## Что это

Плагин opencode для управления сессиями: pin, backup, restore, auto-cleanup, search.
Работает через естественный язык — модель сама вызывает нужные tools.

## Возможности

- Pin/unpin сессий для защиты от автоочистки
- Бэкап отдельных сессий и всех pinned
- Восстановление из бэкапа (с force-перезаписью)
- Полный бэкап для переноса на другую машину
- Поиск сессий по подстроке в названии
- Auto-cleanup старых непinned сессий (backup-then-delete)
- Ротация старых бэкапов с защитой pinned и orphaned
- Настройка через `sm_config` и просмотр через `sm_settings`

## Установка

Добавьте scoped-пакет в массив `plugin` файла `~/.config/opencode/opencode.json` — opencode сам установит его из npm:

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["@enerjizeit/opencode-session-manager"]
}
```

Перезапустите opencode — плагин загрузится автоматически. Подробности по использованию — см. `USAGE.md`.

**Локальная разработка / установка из исходников** (clone + build):

```bash
git clone https://github.com/EnerJizeIT/opencode-session-manager.git
cd opencode-session-manager && ./install.sh
```

## Обновление

opencode **не обновляет плагины автоматически** — он пинит версию при первой установке.
Чтобы обновиться до новой версии:

```bash
rm -rf ~/.cache/opencode/packages/@enerjizeit/opencode-session-manager
rm -rf ~/.cache/opencode/packages/@enerjizeit/opencode-session-manager@latest
```
Затем перезапустите opencode — он переустановит `@latest` из npm. (Или пиньте точную версию в `plugin[]`, напр. `"@enerjizeit/opencode-session-manager@1.0.2"`.)

## Архитектура

### Хранение

State-файл `session-manager.json` хранит pinned-список и настройки.
Запись атомарная: `.tmp` → `rename`. Бэкапы в `backups/<id>.json`.
Всё лежит вне БД opencode — переживёт переустановку.

### CLI-first

Все операции с сессиями идут через `opencode` CLI (Bun shell `$`), не через прямой SQL.
Write-SQL запрещён. `parseJson` терпит `[page-assist]`-шум в stdout.

### Backup envelope

Формат: `{version, exportedAt, backupOf, session}`, где `session` — сырой `opencode export`
(родной round-trip для `opencode import`). Формализован в `backup-schema.json`.

### Backup-then-delete

Удаление только после успешного бэкапа. Команды `opencode session archive` не существует,
поэтому cleanup = бэкап → `opencode session delete`.

### Protected backups

Pinned-бэкапы и orphaned (сессии уже нет в БД — это единственная копия) защищены навсегда.
Corrupt-файлы переименовываются в `.corrupt`.

### Хуки

- `session.idle` — auto cleanup + backup retention; дебаунс 1 час через `lastAutoRun`
- `session.deleted` — уборка удалённой сессии из pinned-списка
- Хуки никогда не роняют opencode (try/catch на каждом уровне)

### Миграция

`version` в state + `migrateState` (merge-with-defaults) для будущих изменений схемы.

## Файлы проекта

| Файл | Описание |
|---|---|
| `session-manager.ts` | Плагин (12 tools, 2 hooks) |
| `backup-schema.json` | JSON Schema backup envelope |
| `README.md` | Английский README |
| `USAGE.md` | Пользовательский гайд |

## Детали

Архитектура кратко описана в разделе «Архитектура» выше; полный пользовательский гайд — `USAGE.md`.
