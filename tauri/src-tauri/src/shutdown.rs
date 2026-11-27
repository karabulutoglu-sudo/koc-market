use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    Close,
    Update,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Waiting(u32, Intent),
    Prompt(u32, Intent),
    Finishing,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Flush {
    Ready(Intent),
    Busy,
    Stale,
}

struct State {
    phase: Phase,
    generation: u32,
    writers: usize,
}

pub struct Shutdown(Mutex<State>);

impl Shutdown {
    pub fn new() -> Self {
        Self(Mutex::new(State { phase: Phase::Idle, generation: 0, writers: 0 }))
    }

    pub fn start(&self, intent: Intent) -> Option<u32> {
        let mut state = self.0.lock().ok()?;
        if state.phase != Phase::Idle {
            return None;
        }
        state.generation = state.generation.wrapping_add(1).max(1);
        state.phase = Phase::Waiting(state.generation, intent);
        Some(state.generation)
    }

    pub fn active(&self) -> bool {
        self.0.lock().map(|state| state.phase != Phase::Idle).unwrap_or(true)
    }

    pub fn begin_write(&self) -> Result<WritePermit<'_>, String> {
        let mut state = self.0.lock().map_err(|_| "Kapanış kilidi bozuk")?;
        if state.phase == Phase::Finishing {
            return Err("Uygulama kapanıyor.".into());
        }
        state.writers += 1;
        Ok(WritePermit { shutdown:self })
    }

    pub fn acknowledge(&self, generation: u32) -> Flush {
        let Ok(mut state) = self.0.lock() else { return Flush::Stale; };
        let Phase::Waiting(current, intent) = state.phase else { return Flush::Stale; };
        if current != generation {
            return Flush::Stale;
        }
        if state.writers > 0 {
            return Flush::Busy;
        }
        state.phase = Phase::Finishing;
        Flush::Ready(intent)
    }

    pub fn begin_prompt(&self, generation: u32) -> Option<Intent> {
        let mut state = self.0.lock().ok()?;
        let Phase::Waiting(current, intent) = state.phase else { return None; };
        if current != generation {
            return None;
        }
        state.phase = Phase::Prompt(generation, intent);
        Some(intent)
    }

    pub fn end_prompt(&self, generation: u32, force: bool) -> Option<Intent> {
        let mut state = self.0.lock().ok()?;
        let Phase::Prompt(current, intent) = state.phase else { return None; };
        if current != generation {
            return None;
        }
        state.phase = if force && intent == Intent::Close { Phase::Finishing } else { Phase::Idle };
        Some(intent)
    }
}

pub struct WritePermit<'a> {
    shutdown: &'a Shutdown,
}

impl Drop for WritePermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shutdown.0.lock() {
            state.writers -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_requires_current_acknowledgement_and_finished_native_writes() {
        let close = Shutdown::new();
        let write = close.begin_write().unwrap();
        let generation = close.start(Intent::Close).unwrap();
        assert_eq!(close.acknowledge(generation), Flush::Busy);
        assert_eq!(close.start(Intent::Close), None);
        drop(write);
        assert_eq!(close.acknowledge(generation), Flush::Ready(Intent::Close));
        assert!(close.begin_write().is_err());
        assert_eq!(close.acknowledge(generation), Flush::Stale);
    }

    #[test]
    fn watchdog_prompts_once_and_a_late_ack_cannot_close() {
        let close = Shutdown::new();
        let generation = close.start(Intent::Update).unwrap();
        assert_eq!(close.begin_prompt(generation), Some(Intent::Update));
        assert_eq!(close.begin_prompt(generation), None);
        assert_eq!(close.acknowledge(generation), Flush::Stale);
        assert_eq!(close.end_prompt(generation, true), Some(Intent::Update));
        assert!(close.begin_write().is_ok());
        let retry = close.start(Intent::Update).unwrap();
        assert_ne!(retry, generation);
        assert_eq!(close.acknowledge(generation), Flush::Stale);
        assert_eq!(close.acknowledge(retry), Flush::Ready(Intent::Update));
    }

    #[test]
    fn ordinary_close_requires_explicit_force_after_a_prompt() {
        let close = Shutdown::new();
        let generation = close.start(Intent::Close).unwrap();
        assert_eq!(close.end_prompt(generation, true), None);
        assert_eq!(close.begin_prompt(generation), Some(Intent::Close));
        assert_eq!(close.end_prompt(generation, false), Some(Intent::Close));
        assert!(!close.active());
        let retry = close.start(Intent::Close).unwrap();
        assert_eq!(close.begin_prompt(retry), Some(Intent::Close));
        assert_eq!(close.end_prompt(retry, true), Some(Intent::Close));
        assert!(close.begin_write().is_err());
    }
}
