import pytest

from services import harmonize_storage
from services.harmonize_storage import (
    CohortFileError,
    new_run_dir,
    read_header,
    remove_run_dir,
    save_cohort_file,
)


def test_bom_and_tab_header(tmp_path):
    p = save_cohort_file(tmp_path, "a", "a.tsv", b"\xef\xbb\xbfname\thmdb\nGlucose\tHMDB0000122\n")
    assert read_header(p) == ["name", "hmdb"]


@pytest.mark.parametrize("data,name", [(b"", "a.csv"), (b"x", "a.xlsx"), (b"\xff\xfe\x00", "a.csv")])
def test_bad_files_raise(tmp_path, data, name):
    with pytest.raises(CohortFileError):
        save_cohort_file(tmp_path, "a", name, data)


def test_oversize_and_bad_label_raise(tmp_path, monkeypatch):
    monkeypatch.setattr(harmonize_storage, "MAX_COHORT_BYTES", 4)
    with pytest.raises(CohortFileError):
        save_cohort_file(tmp_path, "a", "a.csv", b"name\nx\n")
    monkeypatch.undo()
    with pytest.raises(CohortFileError):
        save_cohort_file(tmp_path, "../a", "a.csv", b"name\nx\n")


def test_txt_saved_with_suffix_matching_its_delimiter(tmp_path):
    # The job runner picks the delimiter from the suffix, so a comma .txt must become .csv.
    p = save_cohort_file(tmp_path, "c", "panel.txt", b"name,hmdb\nGlucose,HMDB0000122\n")
    assert p.name == "c.csv"
    assert read_header(p) == ["name", "hmdb"]
    p = save_cohort_file(tmp_path, "d", "panel.csv", b"name\thmdb\nGlucose\tHMDB0000122\n")
    assert p.name == "d.tsv"


def test_run_dir_layout_and_removal(tmp_path, monkeypatch):
    monkeypatch.setattr(harmonize_storage, "HARMONIZE_HOME", tmp_path)
    upload_id, run_dir = new_run_dir()
    assert run_dir == tmp_path / "runs" / upload_id
    assert {p.name for p in run_dir.iterdir()} == {"inputs", "out", "store"}
    remove_run_dir(run_dir)
    assert not run_dir.exists()
    with pytest.raises(ValueError):
        remove_run_dir(tmp_path)
