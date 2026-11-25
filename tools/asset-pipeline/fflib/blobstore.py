"""blobstore: the content-addressed half of the asset store.

    <store>/blobs/<first two hex>/<sha256>.<ext>

A blob is named by the hash of its bytes and never changes, so two mods that produce the
same file share one copy and a web cache may keep it forever. Putting a file that is already
present costs nothing; a file that is already on this volume is taken in by HARD LINK, so
ingesting an existing build does not duplicate it either.
"""
import hashlib
import os
import shutil

CHUNK = 1 << 20


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        while True:
            block = fp.read(CHUNK)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def ext_of(name):
    """Lowercase extension without the dot; "bin" when the name has none."""
    ext = os.path.splitext(name)[1][1:].lower()
    return ext if ext.isalnum() else "bin"


class BlobStore(object):
    def __init__(self, root):
        self.root = os.path.abspath(root)
        #: bytes / files this run added to the store
        self.new_bytes = 0
        self.new_count = 0
        #: bytes / files that were already there (deduplicated)
        self.shared_bytes = 0
        self.shared_count = 0

    @staticmethod
    def rel(sha, ext):
        return "blobs/%s/%s.%s" % (sha[:2], sha, ext)

    def abspath(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def has(self, rel):
        return os.path.isfile(self.abspath(rel))

    def _account(self, size, existed):
        if existed:
            self.shared_bytes += size
            self.shared_count += 1
        else:
            self.new_bytes += size
            self.new_count += 1

    def put_file(self, path, move=False, link=True):
        """Take a file into the store; returns its blob path (``blobs/xx/<sha>.<ext>``).

        A new blob is created by hard link (same volume; costs no space) or, when linking is
        impossible or ``link=False``, by copy. A hard link SHARES the bytes with the source:
        use ``link=False`` for a source somebody else may later rewrite in place, or the
        blob would silently change under its hash. ``move=True`` removes the source
        afterwards (a staged build output). A source whose blob already exists is not read
        twice — its hash is enough.
        """
        sha = sha256_file(path)
        rel = self.rel(sha, ext_of(path))
        dst = self.abspath(rel)
        size = os.path.getsize(path)
        existed = os.path.isfile(dst)
        if not existed:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            tmp = dst + ".tmp%d" % os.getpid()
            if os.path.exists(tmp):
                os.remove(tmp)
            linked = False
            if link or move:  # a moved source is ours alone: linking it is always safe
                try:
                    os.link(path, tmp)
                    linked = True
                except OSError:
                    pass
            if not linked:
                shutil.copyfile(path, tmp)
            os.replace(tmp, dst)  # atomic: a reader never sees a half-written blob
        if move:
            os.remove(path)
        self._account(size, existed)
        return rel

    def would_put(self, path):
        """What put_file would return, without touching the store (for dry runs)."""
        rel = self.rel(sha256_file(path), ext_of(path))
        self._account(os.path.getsize(path), self.has(rel))
        return rel

    def put_bytes(self, data, ext):
        sha = sha256_bytes(data)
        rel = self.rel(sha, ext)
        dst = self.abspath(rel)
        existed = os.path.isfile(dst)
        if not existed:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            tmp = dst + ".tmp%d" % os.getpid()
            with open(tmp, "wb") as fp:
                fp.write(data)
            os.replace(tmp, dst)
        self._account(len(data), existed)
        return rel

    def summary(self):
        return "new %d files / %.1f MB, already in the store %d files / %.1f MB" % (
            self.new_count, self.new_bytes / 1048576.0,
            self.shared_count, self.shared_bytes / 1048576.0)
