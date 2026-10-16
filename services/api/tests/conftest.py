import os
from pathlib import Path
import sys

os.environ.setdefault("OMNIPITCH_DB_PATH", ":memory:")
ROOT = Path(__file__).resolve().parents[3]
for package in ("services/api", "services/simulator", "services/analytics", "services/agents"):
    sys.path.insert(0, str(ROOT / package))

# Tests control configuration through monkeypatched environment variables only; a developer's
# untracked services/api/.env (for example azure mode) must not leak into them.
import app.config  # noqa: E402

app.config.load_env_file = lambda path=None: None
