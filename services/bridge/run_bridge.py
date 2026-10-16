"""Launcher so the worker runs from the repository root: python services/bridge/run_bridge.py --once"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from omnipitch_bridge.worker import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
