from enum import Enum
from hashlib import sha1
from operator import itemgetter
from os import listdir, lstat
from os.path import isfile, join
from stat import S_IFMT, S_ISDIR, S_ISREG
from sys import argv
from typing import List, Optional, Tuple, Union

# When comparing files, read in increments of 8 KiB.
BUFSIZE = 8 * 1024
PADDING = 2


class Diff(Enum):
    REMOVED = '\033[91m'
    ADDED = '\033[92m'
    CHANGED = '\033[93m'
    RENAMED = '\033[93m'


class TreeFileNode:
    def __init__(self, diff: Diff, *, renamed_from: Optional[str] = None):
        self.diff = diff
        self.renamed_from = renamed_from


class TreeDirNode:
    def __init__(self):
        self.dirs = {}
        self.files = {}

    def children(self) -> List[Tuple[str, Union[TreeFileNode, 'TreeDirNode']]]:
        entries = list(self.dirs.items()) + list(self.files.items())
        entries.sort(key=itemgetter(0))
        return entries

    def add_file(self, name: str, file: TreeFileNode) -> None:
        self.files[name] = file

    def remove_file(self, name: str) -> None:
        del self.files[name]

    def create_dir(self, name: str) -> 'TreeDirNode':
        new_dir = TreeDirNode()
        self.dirs[name] = new_dir
        return new_dir

    def __len__(self):
        return len(self.dirs) + len(self.files)


def equal_files(f1: str, f2: str) -> bool:
    with open(f1, 'rb') as fp1, open(f2, 'rb') as fp2:
        while True:
            b1 = fp1.read(BUFSIZE)
            b2 = fp2.read(BUFSIZE)
            if b1 != b2:
                return False
            if not b1:
                return True


def hash_file(file: str) -> bytes:
    h = sha1()
    with open(file, 'rb') as f:
        while True:
            b = f.read(BUFSIZE)
            if not b:
                break
            h.update(b)
    return h.digest()


def calc(tree: TreeDirNode, dirA: str, dirB: str) -> None:
    B = set(listdir(dirB))

    hashes = {}

    for ent in listdir(dirA):
        diff = None
        pathA = join(dirA, ent)
        pathB = join(dirB, ent)
        if ent not in B:
            diff = Diff.REMOVED
            if isfile(pathA):
                hashA = hash_file(pathA)
                hashes[hashA] = ent
        else:
            B.remove(ent)
            a = lstat(pathA)
            b = lstat(pathB)
            if S_IFMT(a.st_mode) != S_IFMT(b.st_mode):
                # Files are not of the same type.
                diff = Diff.CHANGED
            elif S_ISDIR(a.st_mode):
                # File is a directory, so recursively scan it.
                calc(tree.create_dir(ent), pathA, pathB)
            elif not S_ISREG(a.st_mode):
                # At least one file is not a file.
                diff = Diff.CHANGED
            elif a.st_size != b.st_size:
                # Sizes are different.
                diff = Diff.CHANGED
            elif not equal_files(pathA, pathB):
                # File contents are different.
                diff = Diff.CHANGED
        if diff is not None:
            tree.add_file(ent, TreeFileNode(diff))

    for ent in B:
        p = join(dirB, ent)
        renamed_from = None
        if isfile(p):
            h = hash_file(p)
            if h in hashes:
                renamed_from = hashes[h]
                tree.remove_file(renamed_from)
                del hashes[h]
        tree.add_file(ent, TreeFileNode(Diff.RENAMED if renamed_from is not None else Diff.ADDED,
                                        renamed_from=renamed_from))


def prune(tree: TreeDirNode) -> True:
    tree.dirs = {name: node for name, node in tree.dirs.items()
                 if prune(node) and node}
    return True


def show(tree: TreeDirNode, level: int = 0, *, prefix: str = '') -> None:
    children = tree.children()
    amount = len(children)
    for i, (name, node) in zip(range(amount), children):
        last = i == amount - 1
        left_align = prefix + ('└' if last else '├') + '─' * PADDING
        if isinstance(node, TreeFileNode):
            if node.diff == Diff.RENAMED:
                print(f"{left_align}{node.diff.value}{{{name} => {node.renamed_from}}}\033[0m")
            else:
                print(f"{left_align}{node.diff.value}{name}\033[0m")
        else:
            print(f"{left_align}\033[1m📁 {name}\033[0m")
            subprefix = (' ' if last else '│') + ' ' * PADDING
            show(node, level + 1, prefix=prefix + subprefix)


if __name__ == "__main__":
    dirA = argv[1]
    dirB = argv[2]
    tree = TreeDirNode()
    calc(tree, dirA, dirB)
    prune(tree)
    print(f"--- {dirA}")
    print(f"+++ {dirB}")
    show(tree)
