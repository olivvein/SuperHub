# SuperHub Ops Runbook (P1)

Ce runbook couvre les points ops critiques P1:
- TLS local fiable (Caddy + CA locale)
- confiance certificat sur macOS et iOS
- supervision/restart du Hub

## 1. Prerequis

- macOS avec `node`, `npm`, `caddy`
- repo SuperHub clone localement
- `mac-mini-de-olivier.local` resolvable depuis les clients LAN
- token configure dans `.env` (ne pas garder `CHANGE_ME_SUPERHUB_TOKEN` en usage reel)

## 2. Demarrage local Hub + Caddy

Depuis la racine du repo:

```bash
npm install
npm run build
```

Terminal Hub:

```bash
npm run --workspace @superhub/hub start
```

Terminal Caddy (avec le Caddyfile du repo):

```bash
caddy run --config deploy/Caddyfile
```

Verification rapide:

```bash
curl -k https://mac-mini-de-olivier.local/api/health
```

## 3. Trust CA locale sur macOS

Caddy avec `tls internal` genere une CA locale. Il faut installer `root.crt` comme autorite de confiance.

1. Localiser le certificat CA Caddy:

```bash
find "$HOME/Library/Application Support/Caddy" -path "*/pki/authorities/local/root.crt" -print
```

2. Installer dans le trousseau Systeme (commande recommandee):

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "<CHEMIN_ROOT_CRT>"
```

3. Validation:

```bash
curl https://mac-mini-de-olivier.local/api/health
```

Si `curl` retourne encore une erreur TLS, verifier dans Keychain Access que le certificat est en `Always Trust`.

## 4. Trust CA locale sur iOS

1. Copier `root.crt` vers l'iPhone (AirDrop/iCloud Drive).
2. Ouvrir le fichier sur iPhone puis installer le profil.
3. Aller dans:
   - `Settings > General > About > Certificate Trust Settings`
4. Activer `Full Trust` pour la CA locale Caddy.
5. Rejoindre le meme LAN que le Mac mini, puis tester:
   - `https://mac-mini-de-olivier.local/console/`
   - `https://mac-mini-de-olivier.local/api/health`

## 5. Supervision Hub (launchd, recommande)

### 5.1 Creer un LaunchAgent utilisateur

Creer `~/Library/LaunchAgents/com.superhub.hub.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.superhub.hub</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>cd /Users/olivierveinand/Documents/DEV/SuperHub && npm run --workspace @superhub/hub start</string>
    </array>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/Users/olivierveinand/Documents/DEV/SuperHub</string>

    <key>StandardOutPath</key>
    <string>/tmp/superhub-hub.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/superhub-hub.err.log</string>
  </dict>
</plist>
```

Charger le service:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.superhub.hub.plist"
launchctl enable "gui/$(id -u)/com.superhub.hub"
launchctl kickstart -k "gui/$(id -u)/com.superhub.hub"
```

Verifier:

```bash
launchctl print "gui/$(id -u)/com.superhub.hub"
tail -n 100 /tmp/superhub-hub.out.log
tail -n 100 /tmp/superhub-hub.err.log
```

Restart manuel:

```bash
launchctl kickstart -k "gui/$(id -u)/com.superhub.hub"
```

Arret/desactivation:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.superhub.hub.plist"
```

### 5.2 Supervision Caddy

Si Caddy est installe via Homebrew:

```bash
brew services start caddy
brew services restart caddy
brew services list
```

Sinon, gerer Caddy via un LaunchAgent similaire.

## 6. Alternative supervision (PM2)

Option utile si tu preferes une supervision Node unifiee:

```bash
npm i -g pm2
pm2 start "npm run --workspace @superhub/hub start" --name superhub-hub
pm2 save
pm2 startup
```

## 7. Smoke tests apres restart

```bash
curl -sS https://mac-mini-de-olivier.local/api/health
curl -sS -H "X-Hub-Token: $HUB_TOKEN" https://mac-mini-de-olivier.local/api/services
curl -sS -H "X-Hub-Token: $HUB_TOKEN" https://mac-mini-de-olivier.local/api/diagnostics
```

Puis valider en navigateur:
- `https://mac-mini-de-olivier.local/console/`
- `https://mac-mini-de-olivier.local/console/pair`

## 8. Troubleshooting console realtime WS

Symptome:
- browser log `WebSocket connection ... failed`
- console fonctionne en HTTP mais pas en push temps reel

Checks:
1. Token valide:
   - `X-Hub-Token` pour HTTP
   - `?token=...` pour WS
2. Allowlist IP:
   - verifier `security.allowlistSubnets`
3. Origin local:
   - en dev local (`http://127.0.0.1:7777/console/`), le hub accepte maintenant `localhost`, `127.0.0.1`, `::1`
4. Endpoint direct:
   - `GET /api/health` doit repondre
   - `ws://127.0.0.1:7777/ws?token=...` doit s'ouvrir depuis navigateur

Notes:
- le dashboard console utilise `hub.dashboard` en push WS.
- fallback HTTP reste actif periodiquement si WS est indisponible.
