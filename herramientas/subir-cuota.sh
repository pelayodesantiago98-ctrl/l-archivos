#!/bin/bash
# Sube la cuota de descargas de 20 GB a 45.
#
# POR QUÉ 45 Y NO 5 TB: los torrents se descargan a /var/torrents, que está en
# el disco de la máquina (89 GB), no en la Storage Box. La caja es la
# biblioteca: allí va la película ya convertida. El fichero original del
# torrent se queda en local mientras se comparta.
#
# Reparto de los 76 GB libres:
#     45  descargas (esta cuota)
#      6  caché del montaje de rclone, que puede crecer hasta ahí
#     10  /var/media/.trabajo, para convertir una película grande
#     12  margen de la máquina: registros, actualizaciones, respiro
#     ---
#     73  de 76
#
# Antes eran 20 porque las películas ocupaban 47 GB de este mismo disco. Al
# irse a la caja quedó el sitio libre, y de ahí el cambio.
set -eu

ENV=/var/www/l-archivos/.env

echo '== antes =='
grep -E 'TORRENTS_' "$ENV" 2>/dev/null || echo '   sin variables: el código usa 20 GB de tope y 8 de margen'

# Se quitan primero por si ya estaban, para no dejar la variable dos veces.
grep -v -E '^TORRENTS_(TOPE_GB|MARGEN_GB)=' "$ENV" > "$ENV.nuevo"
cat >> "$ENV.nuevo" <<'EOS'

# Cuota de descargas de torrents, en GB. Limita el DISCO LOCAL, no la Storage
# Box: los torrents se descargan a /var/torrents y solo la copia ya convertida
# acaba en la caja. Ver el reparto en herramientas/subir-cuota.sh.
TORRENTS_TOPE_GB=45
# Margen que debe quedar libre en la máquina después de aceptar una descarga.
# Subido de 8 a 12 porque ahora la caché del montaje puede comerse 6 GB más.
TORRENTS_MARGEN_GB=12
EOS
mv "$ENV.nuevo" "$ENV"
chown root:www-data "$ENV"
chmod 640 "$ENV"

echo
echo '== despues =='
grep -E 'TORRENTS_' "$ENV"

systemctl restart l-archivos
sleep 3
systemctl is-active l-archivos

