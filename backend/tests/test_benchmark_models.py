import argparse

import pytest

from scripts.benchmark_models import positive_seconds


def test_positive_seconds_rejects_nonpositive_duration() -> None:
    assert positive_seconds("3") == 3
    with pytest.raises(argparse.ArgumentTypeError):
        positive_seconds("0")
    with pytest.raises(argparse.ArgumentTypeError):
        positive_seconds("-1")
