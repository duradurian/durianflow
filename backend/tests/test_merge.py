from app.merge import normalize_whitespace, remove_duplicate_overlap, remove_final_prefix_from_partial


def test_normalize_whitespace() -> None:
    assert normalize_whitespace(" hello   everyone\n") == "hello everyone"


def test_duplicate_phrase_cleanup() -> None:
    previous = "hello everyone welcome to"
    new = "welcome to the demo"
    assert remove_duplicate_overlap(previous, new) == "the demo"


def test_no_overlap_keeps_new_text() -> None:
    assert remove_duplicate_overlap("hello world", "new sentence") == "new sentence"


def test_partial_prefix_cleanup() -> None:
    assert remove_final_prefix_from_partial("this is final", "is final and partial") == "and partial"
