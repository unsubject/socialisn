"""
cleanup_old_data.py
Deletes data files older than RETAIN_DAYS from all raw and processed
data subdirectories. Runs as part of the daily GitHub Actions schedule.

Run:  python scripts/cleanup_old_data.py
"""

import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = REPO_ROOT / "data"
RETAIN_DAYS = 30

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger(__name__)


def main():
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETAIN_DAYS)
    cutoff_date = cutoff.date()
    log.info(f"Removing data files with date before {cutoff_date}")

    removed = 0
    for json_file in DATA_ROOT.rglob("*.json"):
        # Expect filename pattern YYYY-MM-DD*.json
        stem = json_file.stem.split("-morning")[0].split("-evening")[0]
        try:
            file_date = datetime.strptime(stem[:10], "%Y-%m-%d").date()
        except ValueError:
            continue  # Skip files that don't match the date pattern

        if file_date < cutoff_date:
            log.info(f"  Removing: {json_file.relative_to(REPO_ROOT)}")
            json_file.unlink()
            removed += 1

    log.info(f"Cleanup complete. {removed} file(s) removed.")


if __name__ == "__main__":
    main()
