"""On-disk layout for harmonization runs.

Everything a harmonization job reads or writes lives under ``HARMONIZE_HOME``:

* ``home/`` is the job runner's own directory (job records, caches, review evidence).
* ``runs/`` is the only folder the runner may read cohort files from and write reports into.
  Each upload gets ``runs/<upload_id>/`` with ``inputs/``, ``out/`` and ``store/``.

Outputs persist on disk by default; nothing here deletes a run unless asked to.
"""
from __future__ import annotations

import csv
import os
import re
import shutil
import uuid
from pathlib import Path

_DEFAULT_HOME = Path(__file__).resolve().parent.parent / "data" / "harmonize"

HARMONIZE_HOME: Path = Path(
    os.environ.get("BIOMAPPER_HARMONIZE_HOME", "").strip() or _DEFAULT_HOME
).expanduser()

MAX_COHORT_BYTES = 50 * 1024 * 1024
ALLOWED_SUFFIXES = (".csv", ".tsv", ".txt")
# The package's CohortSpec label rule: letters, digits, '.', '-', '_'. Matched with fullmatch,
# because "$" would also accept a trailing newline.
_LABEL_RE = re.compile(r"[A-Za-z0-9._-]+")


class CohortFileError(ValueError):
    """A cohort upload that cannot be used. The message is written for the end user."""


def check_label(label: str) -> None:
    """Refuse a cohort label outside the rule every harmonization kind shares.

    Raises:
        CohortFileError: The label is not one or more letters, digits, '.', '-' and '_'.
    """
    if not isinstance(label, str) or _LABEL_RE.fullmatch(label) is None:
        raise CohortFileError(
            f"Cohort label {label!r} can only use letters, digits, '.', '-' and '_'."
        )


def runs_root() -> Path:
    return HARMONIZE_HOME / "runs"


def jobs_home() -> Path:
    return HARMONIZE_HOME / "home"


def new_run_dir() -> tuple[str, Path]:
    """Create ``runs_root()/<upload_id>`` with ``inputs/``, ``out/`` and ``store/``."""
    upload_id = uuid.uuid4().hex
    run_dir = runs_root() / upload_id
    for sub in ("inputs", "out", "store"):
        (run_dir / sub).mkdir(parents=True, exist_ok=False)
    return upload_id, run_dir


def _delimiter(first_line: str, suffix: str) -> str:
    # Count separators outside double-quoted fields only: a quoted column name such as
    # "Description, notes" must not vote for comma. Each '"' flips the quoted state, so an
    # escaped quote ("") flips it twice and leaves it unchanged.
    tabs = commas = 0
    quoted = False
    for ch in first_line:
        if ch == '"':
            quoted = not quoted
        elif not quoted:
            if ch == "\t":
                tabs += 1
            elif ch == ",":
                commas += 1
    if tabs != commas:
        return "\t" if tabs > commas else ","
    return "," if suffix == ".csv" else "\t"


def save_cohort_file(run_dir: Path, label: str, filename: str, data: bytes) -> Path:
    """Validate an uploaded cohort file and write it to ``run_dir/inputs``.

    The saved file is named ``<label>.csv`` or ``<label>.tsv`` after the delimiter its header
    actually uses, because the job runner picks the delimiter from the file suffix.

    Raises:
        CohortFileError: The file is empty, over 50 MB, not .csv/.tsv/.txt, not UTF-8 text, or
            the label is not letters, digits, '.', '-' and '_'.
    """
    check_label(label)
    suffix = Path(filename or "").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise CohortFileError(
            f"{filename!r} is not a supported cohort file. Upload a .csv, .tsv or .txt file."
        )
    if not data:
        raise CohortFileError(f"{filename!r} is empty.")
    if len(data) > MAX_COHORT_BYTES:
        raise CohortFileError(f"{filename!r} is larger than the 50 MB limit.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise CohortFileError(f"{filename!r} is not UTF-8 text.") from None
    if not text.strip():
        raise CohortFileError(f"{filename!r} is empty.")
    first_line = text.splitlines()[0] if text else ""
    saved_suffix = ".tsv" if _delimiter(first_line, suffix) == "\t" else ".csv"
    inputs = run_dir / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    path = inputs / f"{label}{saved_suffix}"
    path.write_bytes(data)
    return path


def read_header(path: Path) -> list[str]:
    """The column names of a cohort file. Strips a UTF-8 BOM; sniffs comma vs tab."""
    with Path(path).open(newline="", encoding="utf-8-sig") as fh:
        first_line = fh.readline()
    first_line = first_line.rstrip("\r\n")
    if not first_line:
        return []
    delimiter = _delimiter(first_line, Path(path).suffix.lower())
    return next(csv.reader([first_line], delimiter=delimiter))


def remove_run_dir(run_dir: Path) -> None:
    """Delete one run directory. Refuses anything that is not a run under ``runs_root()``."""
    root = runs_root().resolve()
    target = Path(run_dir).resolve()
    if target.parent != root:
        raise ValueError(f"{run_dir} is not a run directory under {root}")
    shutil.rmtree(target)
