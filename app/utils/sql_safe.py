"""Helpers for safe SQL LIKE / ILIKE patterns (wildcard and escape handling)."""

LIKE_ESCAPE_CHAR = "\\"


def escape_like_pattern(value: str, *, escape_char: str = LIKE_ESCAPE_CHAR) -> str:
    """Treat `%`, `_`, and the escape character in *value* as literals for LIKE/ILIKE.

    Use together with ``column.ilike(pattern, escape=escape_char)`` (or LIKE).
    """
    if len(escape_char) != 1:
        msg = "escape_char must be exactly one character"
        raise ValueError(msg)
    return (
        value.replace(escape_char, escape_char * 2)
        .replace("%", escape_char + "%")
        .replace("_", escape_char + "_")
    )


def ilike_contains(column, text: str, *, escape_char: str = LIKE_ESCAPE_CHAR):
    """``column ILIKE '%text%'`` with *text* wildcards escaped."""
    pattern = f"%{escape_like_pattern(text, escape_char=escape_char)}%"
    return column.ilike(pattern, escape=escape_char)
