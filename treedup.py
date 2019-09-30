from hashlib import sha1
from os import listdir, lstat
from os.path import join, relpath
from queue import Queue
from stat import S_ISDIR, S_ISREG
from sys import argv
from typing import Dict, Set

# When hashing files, read in increments of 8 KiB.
BUFSIZE = 8 * 1024


def hash_file(file: str) -> bytes:
    h = sha1()
    with open(file, 'rb') as f:
        while True:
            b = f.read(BUFSIZE)
            if not b:
                break
            h.update(b)
    return h.digest()


def calc(root_dir: str) -> Dict[bytes, Set[str]]:
    hashes = {}
    queue = Queue()
    queue.put(root_dir)

    while not queue.empty():
        d = queue.get()
        for ent in listdir(d):
            path = join(d, ent)
            stat = lstat(path)
            if S_ISREG(stat.st_mode):
                h = hash_file(path)
                if h not in hashes:
                    hashes[h] = set()
                hashes[h].add(path)
            elif S_ISDIR(stat.st_mode):
                queue.put(path)

    return hashes


def prune(hashes: Dict[bytes, Set[str]]) -> True:
    return {h: paths for h, paths in hashes.items() if len(paths) > 1}


def show(hashes: Dict[bytes, Set[str]], rel: str) -> None:
    for paths in hashes.values():
        print()
        for path in paths:
            print(f"{relpath(path, rel)}")


if __name__ == "__main__":
    d = argv[1]
    print(f"Finding duplicates in {d}...")
    show(prune(calc(d)), d)
