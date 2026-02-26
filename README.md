# openclaw-deltachat-channel

Канал Delta Chat для OpenClaw Gateway.

Состояние
- Текущая стабильная конфигурация: плагин отключён в Gateway (чтобы избежать падений). Работоспособность восстановлена через локальный runner: run-deltachat-channel.js.
- Репозиторий очищен от node_modules и история переписана (force-push). Есть бэкап: /root/.openclaw/workspace/openclaw-deltachat-channel-pre-filter.bundle

Требования
- Node.js (совместимая версия, см. package.json)
- npm или yarn
- Доступ к конфигу OpenClaw / Delta Chat (openclaw.json)

Быстрый старт (локально)
1. Клонировать репо:
   git clone git@github.com:your/repo.git
2. Установить зависимости:
   npm ci
3. Запустить runner для теста:
   node run-deltachat-channel.js

Рекомендация для продакшна — systemd
- Создайте файл /etc/systemd/system/deltachat-channel.service:

[Unit]
Description=DeltaChat Channel Runner
After=network.target

[Service]
WorkingDirectory=/root/.openclaw/workspace
ExecStart=/usr/bin/node /root/.openclaw/workspace/run-deltachat-channel.js
Restart=on-failure
User=root
EnvironmentFile=/etc/default/deltachat-channel

[Install]
WantedBy=multi-user.target

- /etc/default/deltachat-channel можно использовать для переменных окружения (с правами 600).

Безопасность
- Никогда не храните пароли/секреты в репозитории. Используйте:
  - EnvironmentFile с правами доступа (systemd)
  - Секретный менеджер / vault
  - Переменные CI/CD

Бэкапы и откат
- Бэкап перед переписыванием истории: /root/.openclaw/workspace/openclaw-deltachat-channel-pre-filter.bundle
- Если нужно вернуть предыдущую версию — можно распаковать бандл или восстановить из локального бэкапа.

Примечание о репозитории
- История была перезаписана (force push). Все, у кого были локальные клоны, должны выполнить:
  git fetch origin
  git reset --hard origin/master
  или переклонировать репозиторий заново.

Контакты / помощь
- Могу: настроить systemd unit, подготовить EnvironmentFile, обновить readme под другие пути, или уведомить команду о переписанной истории.
