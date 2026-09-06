"""Cross-runtime SQLite format checks on freshly generated synthetic databases."""
import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


def readonly(file):
    # Only for closed synthetic snapshots. Live WAL needs an online backup.
    if Path(str(file) + "-wal").exists() or Path(str(file) + "-shm").exists():
        raise ValueError("WAL sidecars present: online backup required")
    return sqlite3.connect(file.as_uri() + "?mode=ro&immutable=1", uri=True)


def snapshot(db):
    schema = db.execute("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").fetchall()
    rows = {}
    for kind, name, _, _ in schema:
        if kind == "table":
            quoted = '"' + name.replace('"', '""') + '"'
            rows[name] = sorted(db.execute("SELECT * FROM " + quoted).fetchall(), key=repr)
    return schema, rows


class StorageProbe(unittest.TestCase):
    def test_baseline_databases_backup_round_trip(self):
        with tempfile.TemporaryDirectory(prefix="telebox-rewrite-storage-") as directory:
            fixtures = json.loads(subprocess.check_output([
                "node", str(Path(__file__).with_name("storage-fixture.cjs")), directory,
            ], text=True))
            self.assertEqual(len(fixtures), 5)
            for fixture in fixtures:
                with self.subTest(database=fixture["name"]):
                    original = Path(fixture["file"])
                    before = hashlib.sha256(original.read_bytes()).hexdigest()
                    with closing(readonly(original)) as old:
                        self.assertEqual(old.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                        expected = snapshot(old)
                        row = old.execute("SELECT * FROM rewrite_fixture").fetchone()
                        self.assertEqual(row, (9007199254740993, bytes([0, 255, 1]), None,
                                               '{"unknown":{"keep":true}}'))
                        target = original.with_suffix(".candidate.db")
                        with closing(sqlite3.connect(target)) as candidate:
                            old.backup(candidate)
                            self.assertEqual(snapshot(candidate), expected)
                            rollback = original.with_suffix(".rollback.db")
                            with closing(sqlite3.connect(rollback)) as restored:
                                candidate.backup(restored)
                                self.assertEqual(snapshot(restored), expected)
                                self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                    self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(), before)

    def test_snapshot_reader_rejects_active_wal(self):
        with tempfile.TemporaryDirectory(prefix="telebox-rewrite-storage-") as directory:
            file = Path(directory) / "live.db"
            with closing(sqlite3.connect(file)) as writer:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("CREATE TABLE pending (id INTEGER)")
                writer.execute("INSERT INTO pending VALUES (1)")
                writer.commit()
                with self.assertRaisesRegex(ValueError, "online backup"):
                    readonly(file)

    def test_online_backup_includes_committed_wal_rows(self):
        with tempfile.TemporaryDirectory(prefix="telebox-rewrite-storage-") as directory:
            source = Path(directory) / "source.db"
            with closing(sqlite3.connect(source)) as writer:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)")
                writer.execute("INSERT INTO messages VALUES (?, ?)", (9007199254740993, "synthetic"))
                writer.commit()
                self.assertGreater(Path(str(source) + "-wal").stat().st_size, 0)
                with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as reader:
                    with closing(sqlite3.connect(Path(directory) / "backup.db")) as target:
                        reader.backup(target)
                        self.assertEqual(target.execute("SELECT * FROM messages").fetchall(),
                                         [(9007199254740993, "synthetic")])
                        self.assertEqual(target.execute("PRAGMA integrity_check").fetchone()[0], "ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
