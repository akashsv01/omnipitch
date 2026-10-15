import os
from pathlib import Path
import sys

os.environ.setdefault("OMNIPITCH_DB_PATH", ":memory:")
ROOT = Path(__file__).resolve().parents[3]
for package in ("services/api", "services/simulator", "services/analytics", "services/agents"):
    sys.path.insert(0, str(ROOT / package))
