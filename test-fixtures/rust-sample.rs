use std::sync::{Arc, Mutex};
use std::io::Result as IoResult;
use crate::engine::{core::{Runner, State}, metrics};
pub use super::types::*;

pub struct DataWorker {
    id: usize,
    state: Arc<Mutex<State>>,
}

pub enum WorkerStatus {
    Idle,
    Running,
    Failed(String),
}

pub trait Worker {
    fn execute(&self, task_name: &str) -> IoResult<()>;
}

impl Worker for DataWorker {
    fn execute(&self, task_name: &str) -> IoResult<()> {
        let fake = "
fn fake_rust_function() -> bool { false }
";
        println!("Running: {} {}", task_name, fake);
        self.internal_step();
        Ok(())
    }
}

impl DataWorker {
    pub fn new(
        id: usize,
        state: Arc<Mutex<State>>,
    ) -> Self {
        DataWorker { id, state }
    }

    fn internal_step(&self) {
        println!("Stepping worker {}", self.id);
    }
}

pub fn spawn_worker(id: usize) -> DataWorker {
    let state = Arc::new(Mutex::new(State::default()));
    DataWorker::new(id, state)
}
