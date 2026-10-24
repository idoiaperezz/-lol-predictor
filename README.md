# Predictor pre-partida LoL

Página pública con actualización automática diaria.

## Cómo funciona

- Cada hora, GitHub Actions ejecuta `scripts/update.js`. Solo hace algo la primera vez de cada día a partir de las 00:00 (hora de Madrid).
- El script descarga de Google Drive los CSV de Oracle’s Elixir (de 2020 en adelante), entrena el modelo y publica la web en GitHub Pages con un `data/model.json` ya preparado.
- Los CSV nunca se publican: se guardan en la caché privada de GitHub Actions. Los años pasados solo se descargan una vez.
- Si Google limita la descarga («download quota exceeded»), no da error: lo reintenta en la ejecución de la hora siguiente.

## Configuración (solo una vez)

1. **Settings → Secrets and variables → Actions → New repository secret**: nombre `DRIVE_API_KEY`, valor tu clave de API de Google.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Actions → Actualizar datos → Run workflow** para la primera carga.

La página queda en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.

## Ajustes opcionales (en el workflow, sección `env`)

- `MIN_YEAR`: primer año que se usa (por defecto 2020).
- `TIMEZONE`: zona horaria para decidir cuándo empieza el día (por defecto `Europe/Madrid`).
- `DRIVE_FOLDER_ID`: carpeta de Drive (por defecto la de Oracle’s Elixir).

«Run workflow» fuerza una actualización completa en cualquier momento.
