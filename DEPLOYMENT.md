# Deployment Guide

## Сборка для Windows

```bash
# 1. Установить зависимости
npm install

# 2. Собрать .exe
npm run build

# Результат: dist/MCPanel Setup 1.0.0.exe
```

## Сборка для всех платформ

```bash
npm run build:all
```

Результаты:
- **Windows**: `dist/MCPanel Setup 1.0.0.exe`
- **macOS**: `dist/MCPanel-1.0.0.dmg`
- **Linux**: `dist/MCPanel-1.0.0.AppImage`

## Требования для сборки

### Windows
- Node.js 16+
- npm
- Windows 10/11

### macOS
- Node.js 16+
- Xcode Command Line Tools
- macOS 10.13+

### Linux
- Node.js 16+
- build-essential
- libgtk-3-dev

## Оптимизация размера

Текущий размер установщика: ~150-200 MB

Для уменьшения:
1. Удалить DevTools в продакшене
2. Использовать `electron-builder` с `asar: true`
3. Исключить ненужные файлы в `package.json`

```json
"build": {
  "files": [
    "main.js",
    "preload.js",
    "src/**",
    "public/**",
    "!**/*.map",
    "!**/node_modules/*/{CHANGELOG.md,README.md,*.d.ts}"
  ]
}
```

## Автообновления

Для добавления автообновлений используй `electron-updater`:

```bash
npm install electron-updater
```

```js
// main.js
const { autoUpdater } = require('electron-updater')

app.on('ready', () => {
  autoUpdater.checkForUpdatesAndNotify()
})
```

## Подпись кода

### Windows
Нужен сертификат Code Signing:
```json
"win": {
  "certificateFile": "cert.pfx",
  "certificatePassword": "password"
}
```

### macOS
Нужен Apple Developer ID:
```json
"mac": {
  "identity": "Developer ID Application: Your Name (TEAM_ID)"
}
```

## CI/CD

### GitHub Actions

```yaml
name: Build
on: [push]
jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: 18
      - run: npm install
      - run: npm run build
      - uses: actions/upload-artifact@v2
        with:
          name: ${{ matrix.os }}-build
          path: dist/
```

## Публикация

### GitHub Releases
```bash
# Создать тег
git tag v1.0.0
git push origin v1.0.0

# Загрузить артефакты в Release
gh release create v1.0.0 dist/*.exe dist/*.dmg dist/*.AppImage
```

### Microsoft Store (Windows)
1. Зарегистрироваться в Partner Center
2. Создать appx пакет
3. Загрузить через Partner Center

### Mac App Store
1. Зарегистрироваться в Apple Developer
2. Создать App ID
3. Собрать с mas target: `electron-builder --mac mas`
4. Загрузить через Transporter

## Troubleshooting

### Ошибка "Application not signed"
- Windows: Получи Code Signing сертификат
- macOS: Подпиши через `codesign`

### Большой размер установщика
- Проверь `node_modules` на лишние зависимости
- Используй `npm prune --production`
- Включи `asar` в electron-builder

### Не работает после установки
- Проверь пути к ресурсам (используй `app.getAppPath()`)
- Проверь права доступа к файлам
- Посмотри логи в `%APPDATA%/mcpanel/logs`
