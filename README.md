# treeutils

Self-contained Python CLI scripts for exploring and managing file system directories.

## treediff.py

Compare two directory trees. Can detect file renames and modifications within the same level of both trees.

```bash
python treediff.py /path/to/a /path/to/b
```

## treedup.py

Finds duplicate files within a directory tree at any level.

```bash
python treedup.py /path/to/dir
```
