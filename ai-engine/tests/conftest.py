"""Test isolation: run tests against a fresh copy of the models/ and datasets/
directories so results are deterministic, then restore the original state —
test runs must never destroy real trained artifacts."""
import os
import shutil

import pytest


@pytest.fixture(scope="session", autouse=True)
def clean_ml_state(tmp_path_factory):
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    backup_root = tmp_path_factory.mktemp("ml-state-backup")
    backed_up = {}
    for sub in ("models", "datasets"):
        path = os.path.join(base, sub)
        had_state = os.path.isdir(path) and any(os.scandir(path))
        if had_state:
            dst = os.path.join(str(backup_root), sub)
            shutil.copytree(path, dst)
            backed_up[sub] = dst
        else:
            os.makedirs(path, exist_ok=True)
    yield
    # restore whatever was present before the session
    for sub, dst in backed_up.items():
        path = os.path.join(base, sub)
        shutil.rmtree(path, ignore_errors=True)
        shutil.copytree(dst, path)