use async_recursion::async_recursion;
use blake3::Hasher;
use clap::Parser;
use crossbeam::channel::unbounded;
use crossbeam::channel::Sender;
use dashmap::DashMap;
use futures::stream::iter;
use futures::StreamExt;
use indicatif::MultiProgress;
use indicatif::ProgressBar;
use indicatif::ProgressStyle;
use itertools::Itertools;
use rustc_hash::FxHasher;
use std::fs::File;
use std::hash::BuildHasherDefault;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::spawn;
use terminal_size::terminal_size;
use terminal_size::Width;
use tokio::fs::read_dir;
use tokio::fs::symlink_metadata;

// We use async to iterate the file system tree and build the progress bar, and a sync thread pool to do the actual hashing. We don't want to hash within async, as it'll block the progress bar building, and we don't want to use spawn_blocking as it'll run too many threads. We use async to build the tree as it's faster than sync, even with multiple threads.

type Hashes = Arc<DashMap<Vec<u8>, Vec<PathBuf>, BuildHasherDefault<FxHasher>>>;

#[derive(Debug, Parser)]
#[command(author, version, about)]
struct Cli {
  /// Root directory.
  root: PathBuf,

  /// Do not print formatted output.
  #[arg(long, default_value_t = false)]
  raw: bool,
}

#[derive(Clone)]
struct Ctx {
  mp: MultiProgress,
  pb: ProgressBar,
  // (path, size). Use size for more accurate progress indication.
  sender: Sender<(PathBuf, u64)>,
}

#[async_recursion]
async fn visit_file(ctx: &Ctx, path: &Path) -> Result<(), String> {
  // Symlinks, if they resolve, will obviously be a duplicate. Also, multiple symlinks to the same file doesn't really mean anything. Therefore, lstat and ignore symlinks.
  let meta = symlink_metadata(path)
    .await
    .map_err(|err| format!("failed to stat file: {}", err))?;
  if meta.is_dir() {
    if let Err(err) = visit_dir(ctx, path).await {
      ctx.mp.println(format!("⚠️ [{:?}] {}", path, err)).unwrap();
      return Ok(());
    };
  };
  if !meta.is_file() {
    return Ok(());
  };
  let size = meta.len();
  if size != 0 {
    ctx.pb.inc_length(size);
    ctx.sender.send((path.to_path_buf(), size)).unwrap();
  };
  Ok(())
}

#[async_recursion]
async fn visit_dir(ctx: &Ctx, dir: &Path) -> Result<(), String> {
  let mut it = read_dir(&dir)
    .await
    .map_err(|err| format!("failed to read folder: {err}"))?;
  while let Some(e) = it
    .next_entry()
    .await
    .map_err(|err| format!("failed to iterate folder: {err}"))?
  {
    if let Err(err) = visit_file(ctx, &e.path()).await {
      ctx
        .mp
        .println(format!("⚠️ [{:?}] {}", e.path(), err))
        .unwrap();
      // Keep processing remaining files.
    };
  }
  Ok(())
}

fn process_file(hashes: Hashes, path: &Path) -> Result<(), String> {
  let mut hasher = Hasher::new();
  let mut file = File::open(path).map_err(|err| format!("failed to open file: {}", err))?;
  loop {
    let mut buf = vec![0u8; 1024 * 64];
    let n = file
      .read(&mut buf)
      .map_err(|err| format!("failed to read file: {}", err))?;
    if n == 0 {
      break;
    };
    hasher.update(&buf[..n]);
  }
  let hash = hasher.finalize().as_bytes().to_vec();
  hashes.entry(hash).or_default().push(path.to_path_buf());
  Ok(())
}

pub async fn hash_files_in_trees(folder_paths: &[&Path]) -> Hashes {
  let Some((Width(term_width), _)) = terminal_size() else {
    panic!("unable to determine terminal width");
  };

  let mp = MultiProgress::new();
  let pb = mp.add(ProgressBar::new(0));
  pb.set_style(
    ProgressStyle::with_template("{spinner:.green} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} ({bytes_per_sec}, {eta})").unwrap().progress_chars("##-")
  );
  pb.set_message("Finding files");
  let (sender, receiver) = unbounded::<(PathBuf, u64)>();
  let hashes: Hashes = Default::default();

  let mut thread_pool = Vec::new();
  for _ in 0..num_cpus::get() {
    let hashes = hashes.clone();
    let mp = mp.clone();
    let pb = pb.clone();
    let receiver = receiver.clone();
    let thread_pb = mp.add(ProgressBar::new_spinner());
    thread_pool.push(spawn(move || {
      for (path, size) in receiver {
        {
          let raw = format!("Processing {:?}", path).chars().collect_vec();
          // TODO Handle underflow.
          let max_len = usize::from(term_width) - 15;
          let mut fmt = String::new();
          if raw.len() >= max_len {
            let (l, r) = raw.split_at(max_len / 2);
            let (_, r) = r.split_at(r.len() - max_len / 2);
            fmt.extend(l);
            fmt.push('…');
            fmt.extend(r);
          } else {
            fmt.extend(raw);
          };
          thread_pb.set_message(fmt);
        };
        thread_pb.tick();
        if let Err(err) = process_file(hashes.clone(), &path) {
          mp.println(format!("⚠️ [{:?}] {}", path, err)).unwrap();
        };
        pb.inc(size);
      }
      thread_pb.finish_and_clear();
    }));
  }
  drop(receiver);

  let ctx = Ctx {
    mp: mp.clone(),
    pb: pb.clone(),
    sender,
  };

  iter(folder_paths)
    .for_each_concurrent(None, |folder_path| {
      let ctx = ctx.clone();
      let mp = mp.clone();
      async move {
        if let Err(err) = visit_dir(&ctx, folder_path).await {
          mp.println(format!("⚠️ [{:?}] {}", folder_path, err))
            .unwrap();
        };
      }
    })
    .await;
  // Drop sender.
  drop(ctx);

  for t in thread_pool {
    t.join().unwrap();
  }
  pb.finish_and_clear();
  mp.clear().unwrap();

  hashes
}
