use clap::Parser;
use colored::Colorize;
use std::path::PathBuf;
use treeutils::hash_files_in_trees;

#[derive(Debug, Parser)]
#[command(author, version, about)]
struct Cli {
  /// Root directory.
  root: PathBuf,

  /// Do not print formatted output.
  #[arg(long, default_value_t = false)]
  raw: bool,
}

#[tokio::main]
async fn main() {
  let cli = Cli::parse();
  let hashes = hash_files_in_trees(&[&cli.root]).await;

  let mut dup = false;
  for e in hashes.iter() {
    let paths = e.value();
    if paths.len() <= 1 {
      continue;
    };
    dup = true;
    if cli.raw {
      for path in paths.iter() {
        println!("{}", path.to_string_lossy());
      }
    } else {
      for (i, path) in paths.iter().enumerate() {
        let path = format!("{:?}", path);
        if i == 0 {
          println!("{}", path.bold());
        } else if i < paths.len() - 1 {
          println!("├ {}", path.bright_blue())
        } else {
          println!("└ {}", path.bright_blue());
        };
      }
    };
    println!("");
  }

  if !dup {
    println!("{}", "No duplicates found".bright_green());
  };
}
