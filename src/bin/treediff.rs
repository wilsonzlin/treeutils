use clap::Parser;
use colored::Colorize;
use edit_distance::edit_distance;
use itertools::Itertools;
use rustc_hash::FxHashMap;
use rustc_hash::FxHashSet;
use std::cmp::min;
use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::path::PathBuf;
use treeutils::hash_files_in_trees;

#[derive(Debug, Parser)]
#[command(author, version, about)]
struct Cli {
  /// Old directory.
  old: PathBuf,

  /// New directory.
  new: PathBuf,

  /// Use relative paths for detected copies.
  #[arg(long, default_value_t = false)]
  relative_copy_paths: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileDiff {
  Changed,
  Created,
  Deleted,
  Unchanged,
}

fn common_prefix<'a, 'b, T: Eq>(a: &'a [T], b: &'b [T]) -> &'a [T] {
  let mut i = 0;
  while i < min(a.len(), b.len()) && a[i] == b[i] {
    i += 1;
  }
  &a[..i]
}

fn relative_to(from: &[String], to: &[String]) -> Vec<String> {
  let mut i = 0;
  while i < min(from.len(), to.len()) && from[i] == to[i] {
    i += 1;
  }
  let mut rel = vec!["..".to_string(); from.len() - i];
  rel.extend_from_slice(&to[i..]);
  rel
}

#[tokio::main]
async fn main() {
  let cli = Cli::parse();
  let old_base = cli.old.canonicalize().expect("resolve old directory");
  let new_base = cli.new.canonicalize().expect("resolve new directory");
  if old_base.starts_with(&new_base) || new_base.starts_with(&old_base) {
    panic!("old and new directories overlap");
  };
  let hashes = hash_files_in_trees(&[&old_base, &new_base]).await;

  // Copies/renames are separate to diffs. We always show files as being added, changed, or removed. However, for files where we think they were renamed or copied because there are identical files in the new dir, we list them alongside the old path diff listing entry as a hint. A rename is simply a copy where the old path is also deleted. One old path could be copied to multiple new paths, but a new path can only ever be associated with one old path.
  let mut copies_from = FxHashMap::default();
  let mut diffs = BTreeMap::<Vec<String>, FileDiff>::new();

  for e in hashes.iter() {
    let mut old_paths = FxHashSet::<Vec<String>>::default();
    let mut new_paths = FxHashSet::<Vec<String>>::default();
    let paths = e.value();
    for path in paths {
      if let Ok(rel_path) = path.strip_prefix(&old_base) {
        old_paths.insert(
          rel_path
            .to_string_lossy()
            .split("/")
            .map(|s| s.to_string())
            .collect(),
        );
      } else {
        new_paths.insert(
          path
            .strip_prefix(&new_base)
            .unwrap()
            .to_string_lossy()
            .split("/")
            .map(|s| s.to_string())
            .collect(),
        );
      };
    }

    // We determine the likely new path based on closeness to old path.
    let mut distances = Vec::new();
    for new_path in new_paths.iter() {
      for old_path in old_paths.iter() {
        let dist = edit_distance(&old_path.join("/"), &new_path.join("/"));
        distances.push((old_path.clone(), new_path.clone(), dist));
      }
    }
    distances.sort_unstable_by_key(|(_, _, dist)| Reverse(*dist));

    // `distances` is sorted by distance descending. New paths will be taken by first closest match. An old path can map to many new paths.
    for (old_path, new_path, _) in distances {
      copies_from.entry(new_path).or_insert(old_path);
    }

    for old_path in old_paths.iter() {
      diffs
        .entry(old_path.clone())
        .and_modify(|e| {
          *e = match e {
            // In a previous `hashes` iteration, this path exists in the new dir.
            FileDiff::Created => FileDiff::Changed,
            _ => unreachable!(),
          }
        })
        .or_insert(if new_paths.contains(old_path) {
          // The old path and new path are identical, and the contents (hashes) are identical.
          FileDiff::Unchanged
        } else {
          FileDiff::Deleted
        });
    }

    for new_path in new_paths.iter() {
      diffs
        .entry(new_path.clone())
        .and_modify(|e| {
          *e = match e {
            FileDiff::Unchanged => FileDiff::Unchanged,
            // In a previous `hashes` iteration, this path exists in the old dir.
            FileDiff::Deleted => FileDiff::Changed,
            _ => unreachable!(),
          }
        })
        .or_insert(FileDiff::Created);
    }
  }

  let copies_to = copies_from
    .iter()
    .map(|(to, from)| (from, to))
    .into_group_map();

  let mut cur_dir = Vec::new();
  for (path, diff) in diffs {
    if diff == FileDiff::Unchanged {
      continue;
    };

    let base = common_prefix(&cur_dir, &path);
    cur_dir = base.to_vec();
    while cur_dir.len() < path.len() - 1 {
      let comp = path[cur_dir.len()].clone();
      println!("{}{}", "  ".repeat(cur_dir.len()), comp);
      cur_dir.push(comp);
    }

    let name = path.last().unwrap();
    let mut msg = match diff {
      FileDiff::Changed => format!("{name}").bright_yellow(),
      FileDiff::Created => format!("{name}").bright_green(),
      FileDiff::Deleted => format!("{name}").bright_red(),
      _ => unreachable!(),
    }
    .to_string();
    if let Some(from) = copies_from.get(&path) {
      // This is useful for unchanged copies as there would be no `=>` entry.
      msg.push_str(
        &format!(
          " <= {}",
          if cli.relative_copy_paths {
            relative_to(&path, from).join("/")
          } else {
            from.join("/")
          }
        )
        .dimmed()
        .to_string(),
      );
    };
    if let Some(tos) = copies_to.get(&path) {
      msg.push_str(
        &format!(
          " => {}",
          tos
            .iter()
            .map(|to| if cli.relative_copy_paths {
              relative_to(&path, to).join("/")
            } else {
              to.join("/")
            })
            .join(", ")
        )
        .bold()
        .to_string(),
      );
    };
    println!("{}{}", "  ".repeat(path.len() - 1), msg);
  }
}
