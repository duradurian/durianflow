import re


_SPACE_RE = re.compile(r"\s+")


def normalize_whitespace(text: str) -> str:
    return _SPACE_RE.sub(" ", text).strip()


def _tokens(text: str) -> list[str]:
    return normalize_whitespace(text).lower().split()


def remove_duplicate_overlap(previous_final: str, new_text: str) -> str:
    previous_tokens = _tokens(previous_final)
    raw_new = normalize_whitespace(new_text)
    new_tokens = raw_new.split()
    comparable_new = [token.lower() for token in new_tokens]

    max_overlap = min(len(previous_tokens), len(new_tokens))
    overlap = 0
    for size in range(1, max_overlap + 1):
        if previous_tokens[-size:] == comparable_new[:size]:
            overlap = size

    return normalize_whitespace(" ".join(new_tokens[overlap:]))


def remove_final_prefix_from_partial(final_text: str, partial_text: str) -> str:
    return remove_duplicate_overlap(final_text, partial_text)
