#!/usr/bin/env bash
# Writes a compressed dump of the database to BACKUP_DIR and deletes dumps older than KEEP_DAYS.
# Run it every night from cron (docs/deploy.md); restore with the command in that guide.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/imotsync}"
KEEP_DAYS="${KEEP_DAYS:-14}"

cd "$(dirname "$0")"
mkdir -p "$BACKUP_DIR"

file="$BACKUP_DIR/imotsync-$(date -u +%Y%m%d-%H%M%S).sql.gz"
# A failed dump leaves no partial file behind.
trap 'rm -f "$file.partial"' EXIT
# --single-transaction: a consistent dump without locking the tables (all of them are InnoDB).
# The root password is read inside the container and passed in the environment, not as an argument.
docker compose exec -T db sh -c \
  'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump --user=root --single-transaction --quick --routines --triggers --default-character-set=utf8mb4 "$MARIADB_DATABASE"' \
  | gzip > "$file.partial"
mv "$file.partial" "$file"

find "$BACKUP_DIR" -name 'imotsync-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup-db: wrote $file ($(du -h "$file" | cut -f1))"
