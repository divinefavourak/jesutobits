//! When to restart a crashed runtime (ADR-0002): back off 0.5, 1, 2 and 4 s, and give up
//! after the fifth crash within two minutes. Pure, so the rules are tested without
//! processes or clocks.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    RestartAfter(Duration),
    /// Too many crashes in the window; carries how many.
    GiveUp(usize),
}

pub struct RestartPolicy {
    backoff: Vec<Duration>,
    window: Duration,
    crashes_until_failed: usize,
    recent: VecDeque<Instant>,
}

impl RestartPolicy {
    pub fn new(backoff: Vec<Duration>, window: Duration, crashes_until_failed: usize) -> Self {
        assert!(!backoff.is_empty() && crashes_until_failed >= 1);
        Self {
            backoff,
            window,
            crashes_until_failed,
            recent: VecDeque::new(),
        }
    }

    /// Records a crash at `now` and decides what to do. The wait grows with the number of
    /// crashes still inside the window, so a runtime that crashes once a day always
    /// restarts after the shortest wait.
    pub fn on_crash(&mut self, now: Instant) -> Decision {
        while self
            .recent
            .front()
            .is_some_and(|&crash| now.duration_since(crash) >= self.window)
        {
            self.recent.pop_front();
        }
        self.recent.push_back(now);
        let count = self.recent.len();
        if count >= self.crashes_until_failed {
            return Decision::GiveUp(count);
        }
        Decision::RestartAfter(self.backoff[(count - 1).min(self.backoff.len() - 1)])
    }

    /// Forgets past crashes; used when the user restarts the runtime from Failed.
    pub fn reset(&mut self) {
        self.recent.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adr_0002() -> RestartPolicy {
        RestartPolicy::new(
            [500, 1000, 2000, 4000].map(Duration::from_millis).to_vec(),
            Duration::from_secs(120),
            5,
        )
    }

    fn secs(s: f64) -> Duration {
        Duration::from_secs_f64(s)
    }

    #[test]
    fn backs_off_then_gives_up_on_the_fifth_crash_in_two_minutes() {
        let mut policy = adr_0002();
        let t0 = Instant::now();
        assert_eq!(policy.on_crash(t0), Decision::RestartAfter(secs(0.5)));
        assert_eq!(
            policy.on_crash(t0 + secs(1.0)),
            Decision::RestartAfter(secs(1.0))
        );
        assert_eq!(
            policy.on_crash(t0 + secs(3.0)),
            Decision::RestartAfter(secs(2.0))
        );
        assert_eq!(
            policy.on_crash(t0 + secs(6.0)),
            Decision::RestartAfter(secs(4.0))
        );
        assert_eq!(policy.on_crash(t0 + secs(11.0)), Decision::GiveUp(5));
    }

    #[test]
    fn crashes_older_than_the_window_are_forgotten() {
        let mut policy = adr_0002();
        let t0 = Instant::now();
        for n in 0..4 {
            policy.on_crash(t0 + secs(f64::from(n)));
        }
        // Two minutes after the first crash, only crashes 2 to 4 still count.
        assert_eq!(
            policy.on_crash(t0 + secs(120.0)),
            Decision::RestartAfter(secs(4.0))
        );
        // A long quiet period resets the wait to the shortest one.
        assert_eq!(
            policy.on_crash(t0 + secs(1000.0)),
            Decision::RestartAfter(secs(0.5))
        );
    }

    #[test]
    fn reset_starts_counting_again() {
        let mut policy = adr_0002();
        let t0 = Instant::now();
        for n in 0..5 {
            policy.on_crash(t0 + secs(f64::from(n)));
        }
        policy.reset();
        assert_eq!(
            policy.on_crash(t0 + secs(6.0)),
            Decision::RestartAfter(secs(0.5))
        );
    }
}
