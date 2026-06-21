#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "🔨 Construyendo proyecto..."
npm run build

echo "📦 Preparando commit..."
git add src/pages/index.astro public/ src/data/ astro.config.mjs package.json 2>/dev/null || true
git add -u

CHANGES=$(git diff --cached --name-only)
if [ -z "$CHANGES" ]; then
  echo "✅ Sin cambios nuevos que subir."
  exit 0
fi

FECHA=$(date '+%Y-%m-%d %H:%M')
git commit -m "Deploy CRM $FECHA"

echo "🚀 Subiendo a GitHub → Netlify..."
git push origin main

echo ""
echo "✅ Listo. Netlify comenzará el deploy automáticamente."
echo "   Revisa el estado en: https://app.netlify.com"
